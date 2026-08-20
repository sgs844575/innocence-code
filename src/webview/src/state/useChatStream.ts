// useChatStream — delta/tool/thinking/permission 流式状态（Task 12 从
// App.tsx 拆出）。职责：活动会话的消息列表、流式气泡 id、权限卡片，以及
// 发送/停止/权限应答命令。事件只作用于 activeId 会话（其余忽略）。
import { useCallback, useEffect, useState } from "react";
import {
  appendText,
  type ChatMessage,
  type ChatPermissionEvent,
  type PermissionChoice,
} from "../../../shared/ipc";
import { api } from "../lib/ipc";

export interface ChatStreamDeps {
  /** 活动会话 id（null = 落地态）。 */
  activeId: string | null;
  /** 落地态首条消息的建会入口（sessionController.ensureSessionForSend）。 */
  ensureSession: () => Promise<string | null>;
  /**
   * 发送前的任务入口（workbench.ensureTask）：会话首条消息时创建任务，
   * 使该回合进入任务作用域（变更捕获/检查点/审查）。
   */
  ensureTask?: (sessionId: string) => Promise<void>;
  /** 错误提示。 */
  showError: (message: string) => void;
  /** i18n。 */
  t: (key: string) => string;
  /** 发送门禁：返回阻断文案时拒绝发送（恢复未决时的写工具门禁等）。 */
  sendGate?: () => string | null;
}

export interface ChatStream {
  messages: ChatMessage[];
  streaming: boolean;
  permission: ChatPermissionEvent | null;
  send: (text: string) => Promise<void>;
  stop: () => void;
  respondPermission: (requestId: string, choice: PermissionChoice) => void;
}

export function useChatStream(deps: ChatStreamDeps): ChatStream {
  const { activeId, ensureSession, ensureTask, showError, t, sendGate } = deps;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [permission, setPermission] = useState<ChatPermissionEvent | null>(null);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    void api.listMessages(activeId).then(setMessages);
  }, [activeId]);

  // Permission asks arrive mid-stream; only one card at a time (the loop
  // resolves asks sequentially).
  useEffect(() => {
    const off = api.onChatPermission((e) => {
      if (e.sessionId !== activeId) return;
      setPermission(e);
    });
    return off;
  }, [activeId]);

  // Streaming events — apply deltas only to the active session.
  useEffect(() => {
    const offDelta = api.onChatDelta((e) => {
      if (e.sessionId !== activeId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === e.messageId ? { ...m, parts: appendText(m.parts, e.delta) } : m,
        ),
      );
    });
    const offDone = api.onChatDone((e) => {
      if (e.sessionId !== activeId) return;
      setStreamingId(null);
      setPermission(null);
      setMessages((prev) =>
        prev.map((m) => (m.id === e.messageId ? { ...m, streaming: false } : m)),
      );
    });
    const offError = api.onChatError((e) => {
      if (e.sessionId !== activeId) return;
      setStreamingId(null);
      setPermission(null);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === e.messageId
            ? { ...m, streaming: false, parts: appendText(appendText(m.parts, "\n\n> ⚠️ "), e.error) }
            : m,
        ),
      );
    });
    // Structured tool parts arrive pre-formed (toolCall/toolResult) and append
    // as-is; thinking deltas extend the trailing thinking part or open one.
    const offTool = api.onChatTool((e) => {
      if (e.sessionId !== activeId) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === e.messageId ? { ...m, parts: [...m.parts, e.part] } : m)),
      );
    });
    const offThinking = api.onChatThinking((e) => {
      if (e.sessionId !== activeId) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== e.messageId) return m;
          const last = m.parts[m.parts.length - 1];
          if (last?.type === "thinking") {
            const parts = [...m.parts];
            parts[parts.length - 1] = { type: "thinking", text: last.text + e.delta };
            return { ...m, parts };
          }
          return { ...m, parts: [...m.parts, { type: "thinking", text: e.delta }] };
        }),
      );
    });
    return () => {
      offDelta();
      offDone();
      offError();
      offTool();
      offThinking();
    };
  }, [activeId]);

  const send = useCallback(
    async (text: string) => {
      const gateMessage = sendGate?.();
      if (gateMessage !== null && gateMessage !== undefined) {
        showError(gateMessage);
        return;
      }
      const sessionId = activeId ?? (await ensureSession());
      if (!sessionId) return;
      // 任务先于发送落地：本回合即进入任务作用域（P1 循环入口）。
      await ensureTask?.(sessionId);

      let messageId: string;
      try {
        ({ messageId } = await api.sendMessage(sessionId, text));
      } catch (err) {
        console.error("send message failed", err);
        showError(t("error.sendMessage"));
        return;
      }
      setStreamingId(messageId);
      // Optimistic UI: user bubble immediately, assistant bubble fills via deltas.
      const optimisticUser: ChatMessage = {
        id: `${messageId}_user`,
        role: "user",
        parts: [{ type: "text", text }],
        createdAt: Date.now(),
      };
      const pendingAssistant: ChatMessage = {
        id: messageId,
        role: "assistant",
        parts: [],
        createdAt: Date.now(),
        streaming: true,
      };
      setMessages((prev) => [...prev, optimisticUser, pendingAssistant]);
    },
    [activeId, ensureSession, ensureTask, sendGate, showError, t],
  );

  const stop = useCallback(() => {
    if (activeId && streamingId) void api.stopMessage(activeId, streamingId);
  }, [activeId, streamingId]);

  const respondPermission = useCallback((requestId: string, choice: PermissionChoice) => {
    setPermission(null);
    void api.respondChatPermission(requestId, choice);
  }, []);

  return {
    messages,
    streaming: streamingId !== null,
    permission,
    send,
    stop,
    respondPermission,
  };
}
