// Harness glue — owns settings persistence, the HarnessRuntime instance and
// the permission-ask bridge between the runtime and the renderer. This module
// is the host composition root: it assembles the concrete plugin set (fs/shell
// tools, subagents, project skills, MCP) per agent session.
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
import {
  loadInnocenceConfig,
  rulesFromConfig,
  type HarnessPlugin,
  type ProjectPermissionConfig,
} from "@innocencecode/harness-core";
import { fsPlugin } from "@innocencecode/tools-fs";
import { shellPlugin } from "@innocencecode/tools-shell";
import { subagentPlugin } from "@innocencecode/plugin-subagent";
import { skillsPlugin } from "@innocencecode/plugin-skills";
import { mcpPlugin } from "@innocencecode/plugin-mcp";
import {
  IPC,
  appendText,
  type ChatPermissionEvent,
  type ChatToolEvent,
  type PermissionChoice,
} from "../shared/ipc";
import * as sessions from "./sessions";
import { getMainWindow } from "./appWindow";
import { broadcastTheme, setTheme } from "./theme";
import { logger } from "./logger";
import { broadcastSessions } from "./sessionEvents";

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

/** Project permission rules (.innocence/config.json) as a plugin, so the
 *  runtime never loads project config itself — the composition root owns it. */
function projectRulesPlugin(config: ProjectPermissionConfig | undefined): HarnessPlugin {
  return {
    name: "project-permission-rules",
    activate(ctx) {
      if (!config) return;
      for (const rule of rulesFromConfig(config)) ctx.registerPolicyRule(rule);
    },
  };
}

/** Host composition root: one workspace's plugin set — workspace tools,
 *  subagents, project permission rules, project skills and MCP servers. */
async function composePlugins(workspaceRoot: string): Promise<HarnessPlugin[]> {
  const config = await loadInnocenceConfig(workspaceRoot);
  return [
    fsPlugin,
    shellPlugin,
    subagentPlugin,
    projectRulesPlugin(config.permissions),
    skillsPlugin({ dirs: [path.join(workspaceRoot, ".innocence", "skills")] }),
    mcpPlugin({ servers: config.mcpServers ?? {} }),
  ];
}

const runtime = new HarnessRuntime({
  settings: () => settings,
  persistDir: transcriptsDir(),
  pluginsForSession: ({ workspaceRoot }) => composePlugins(workspaceRoot),
  hooks: {
    onDelta: (sessionId, messageId, delta) => {
      sessions.updateMessage(sessionId, messageId, (m) => {
        m.parts = appendText(m.parts, delta);
      });
      send(IPC.chatDelta, { sessionId, messageId, delta });
    },
    // Structured tool events: persist the part on the assistant message and
    // broadcast it so the renderer mirrors the live stream part-by-part.
    onTool: (sessionId, messageId, part) => {
      // LiveToolPart carries harness-core's optional isError; the shared
      // contract requires it, so normalize at this boundary.
      const normalized: ChatToolEvent["part"] =
        part.type === "toolCall"
          ? part
          : {
              type: "toolResult",
              toolCallId: part.toolCallId,
              content: part.content,
              isError: part.isError === true,
              durationMs: part.durationMs,
            };
      sessions.updateMessage(sessionId, messageId, (m) => {
        m.parts.push(normalized);
      });
      send(IPC.chatTool, { sessionId, messageId, part: normalized });
    },
    onThinking: (sessionId, messageId, delta) => {
      sessions.updateMessage(sessionId, messageId, (m) => {
        const last = m.parts[m.parts.length - 1];
        if (last?.type === "thinking") last.text += delta;
        else m.parts.push({ type: "thinking", text: delta });
      });
      send(IPC.chatThinking, { sessionId, messageId, delta });
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
        // 脱敏持久化资源摘要（kind/action/scope）——raw 值在 core 侧已
        // 被 persistArgs/permissionResource 挡在门外，这里只透传镜像。
        resource: {
          kind: ask.call.resource.kind,
          action: ask.call.resource.action,
          scope: ask.call.resource.scope,
        },
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
    log: (level, msg, data) => {
      // Route by severity — a runtime dispose failure arrives as "error"
      // and must reach logger.error, not sink into the info stream.
      const entry = { msg, data: String(data) };
      if (level === "error") logger.error("harness", entry);
      else if (level === "warn") logger.warn("harness", entry);
      else logger.info("harness", entry);
    },
  },
});

/** Loads persisted settings; call once at app start (idempotent). Runs
 *  before the window exists, so applying the theme needs no broadcast —
 *  the renderer pulls the resolved theme on load. */
export async function initHarness(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), "utf8"));
    settings = mergeSettings(raw);
  } catch {
    settings = DEFAULT_SETTINGS;
  }
  setTheme(settings.themeMode ?? "system");
  logger.info("harness initialized", { activeProfile: settings.activeProfileId });
}

export function getHarnessSettings(): PkgSettings {
  return settings;
}

export async function setHarnessSettings(next: PkgSettings): Promise<void> {
  const prevTheme = settings.themeMode ?? "system";
  settings = mergeSettings(next);
  // Theme lives in the settings file now — apply + broadcast when it changes
  // so the appearance page is the single control surface.
  const nextTheme = settings.themeMode ?? "system";
  if (nextTheme !== prevTheme) {
    setTheme(nextTheme);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) broadcastTheme(win);
  }
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
    parts: [],
    createdAt: Date.now(),
    streaming: true,
  });
  broadcastSessions();
  void runtime.send(sessionId, text, id);
  return id;
}

export function stopChatTurn(sessionId: string): void {
  runtime.stop(sessionId);
}

/** Releases one chat session's agent resources (aborts runs, disposes its
 *  plugins). Never rejects — failures surface through the harness log. */
export async function disposeSession(sessionId: string): Promise<void> {
  await runtime.dispose(sessionId);
}

/** Rejects every unanswered permission ask (app shutdown): pending turns
 *  must not block on dialogs that will never be answered. */
export function rejectPendingPermissionAsks(): void {
  for (const finish of pendingAsks.values()) finish("deny");
  pendingAsks.clear();
}

/** Releases every agent session's resources (app shutdown): aborts active
 *  runs, disposes all plugins (MCP child trees included). Never rejects. */
export async function disposeAllRuntime(): Promise<void> {
  await runtime.disposeAll();
}
