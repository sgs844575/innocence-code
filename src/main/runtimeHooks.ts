// Runtime UI-bridge hooks (split out of harnessGlue by responsibility): the
// HarnessRuntime hook bundle that mirrors agent events into the session
// store and the renderer (deltas, structured tool parts, thinking,
// completion, errors) plus the permission-ask bridge that surfaces an ask as
// a renderer dialog with a deny-on-timeout guarantee.
import type { BrowserWindow } from "electron";
import type { RuntimeHooks } from "@innocencecode/harness-electron";
import {
  IPC,
  appendText,
  type ChatPermissionEvent,
  type ChatToolEvent,
  type PermissionChoice,
} from "../shared/ipc";
import * as sessions from "./sessions";
import { getMainWindow } from "./appWindow";
import { logger } from "./logger";

/** Unanswered asks default to deny after this long — never block the loop. */
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

function send(channel: string, payload: unknown): void {
  const win: BrowserWindow | undefined = getMainWindow() ?? undefined;
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * Builds the runtime hook bundle. `pendingAsks` is the shared ask registry
 * the host's respondPermission port resolves through (see harnessGlue).
 */
export function createRuntimeHooks(
  pendingAsks: Map<string, (choice: PermissionChoice) => void>,
): RuntimeHooks {
  return {
    onDelta: (sessionId, messageId, delta) => {
      sessions.updateMessage(sessionId, messageId, (m) => {
        m.parts = appendText(m.parts, delta);
      });
      send(IPC.chatDelta, { sessionId, messageId, delta });
    },
    // Structured tool events: persist the part on the assistant message and
    // broadcast it so the renderer mirrors the live stream part-by-part.
    onTool: (sessionId, messageId, part) => {
      // LiveToolPart carries the session spine's optional isError; the shared
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
      sessions.updateMessage(sessionId, messageId, (m) => {
        m.streaming = false;
      });
      send(IPC.chatDone, { sessionId, messageId });
    },
    onError: (sessionId, messageId, error) => {
      sessions.updateMessage(sessionId, messageId, (m) => {
        m.streaming = false;
      });
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
  };
}
