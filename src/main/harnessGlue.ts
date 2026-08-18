// Harness glue — owns settings persistence, the HarnessRuntime instance and
// the permission-ask bridge between the runtime and the renderer.
import { app, dialog, type BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import {
  HarnessRuntime,
  DEFAULT_SETTINGS,
  listModels,
  mergeSettings,
  type HarnessSettings as PkgSettings,
} from "@innocencecode/harness-electron";
import { IPC, type ChatPermissionEvent, type PermissionChoice } from "../shared/ipc";
import * as sessions from "./sessions";
import { getMainWindow } from "./appWindow";
import { logger } from "./logger";

const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

let settings: PkgSettings = DEFAULT_SETTINGS;
const pendingAsks = new Map<string, (choice: PermissionChoice) => void>();

function settingsFile(): string {
  return path.join(app.getPath("userData"), "harness-settings.json");
}

function transcriptsDir(): string {
  return path.join(app.getPath("userData"), "transcripts");
}

function send(channel: string, payload: unknown): void {
  const win: BrowserWindow | undefined = getMainWindow() ?? undefined;
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const runtime = new HarnessRuntime({
  settings: () => settings,
  persistDir: transcriptsDir(),
  hooks: {
    onDelta: (sessionId, messageId, delta) => {
      sessions.updateMessage(sessionId, messageId, (m) => {
        m.content += delta;
      });
      send(IPC.chatDelta, { sessionId, messageId, delta });
    },
    onCompleted: (sessionId, messageId) => {
      sessions.updateMessage(sessionId, messageId, { streaming: false });
      send(IPC.chatDone, { sessionId, messageId });
    },
    onError: (sessionId, messageId, error) => {
      sessions.updateMessage(sessionId, messageId, { streaming: false });
      send(IPC.chatError, { sessionId, messageId, error });
      logger.warn("harness error", { sessionId, messageId, error });
    },
    askPermission: async (sessionId, messageId, ask) => {
      const event: ChatPermissionEvent = {
        sessionId,
        messageId,
        requestId: ask.requestId,
        toolName: ask.call.toolName,
        args: ask.call.args,
      };
      return new Promise<PermissionChoice>((resolve) => {
        let settled = false;
        const finish = (choice: PermissionChoice) => {
          if (settled) return;
          settled = true;
          pendingAsks.delete(ask.requestId);
          clearTimeout(timer);
          resolve(choice);
        };
        // Unanswered asks default to deny — never block the loop forever.
        const timer = setTimeout(() => finish("deny"), PERMISSION_TIMEOUT_MS);
        pendingAsks.set(ask.requestId, finish);
        send(IPC.chatPermission, event);
      });
    },
    log: (level, msg, data) => logger.info("harness", { level, msg, data: String(data) }),
  },
});

/** Loads persisted settings; call once at app start (idempotent). */
export async function initHarness(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), "utf8"));
    settings = mergeSettings(raw);
  } catch {
    settings = DEFAULT_SETTINGS;
  }
  logger.info("harness initialized", { activeProfile: settings.activeProfileId });
}

export function getHarnessSettings(): PkgSettings {
  return settings;
}

export async function setHarnessSettings(next: PkgSettings): Promise<void> {
  settings = mergeSettings(next);
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
}

/** Fetches a platform's model list (runs in main, where network is available). */
export async function listProviderModels(
  profile: Pick<PkgSettings["profiles"][number], "kind" | "apiKey" | "baseURL">,
): Promise<string[]> {
  return listModels(profile);
}

export async function pickWorkspace(): Promise<string> {
  const win = getMainWindow();
  if (!win) return "";
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || result.filePaths.length === 0 ? "" : result.filePaths[0];
}

export function respondPermission(requestId: string, choice: PermissionChoice): void {
  pendingAsks.get(requestId)?.(choice);
}

let nextMsg = 0;
const messageId = () => `msg_${Date.now().toString(36)}_${(nextMsg++).toString(36)}`;

/** Starts an agent turn; returns the assistant message id immediately. */
export function sendChatTurn(sessionId: string, text: string): string {
  const id = messageId();
  sessions.appendMessage(sessionId, {
    id,
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    streaming: true,
  });
  void runtime.send(sessionId, text, id);
  return id;
}

export function stopChatTurn(sessionId: string): void {
  runtime.stop(sessionId);
}

export function disposeSession(sessionId: string): void {
  runtime.dispose(sessionId);
}
