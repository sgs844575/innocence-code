// Local mock "model": streams a canned markdown reply token by token so the UI
// exercises the exact streaming path (chat:delta -> chat:done) without a
// network backend. Swap this module for a real model backend later.
import type { BrowserWindow } from "electron";
import { IPC, type ChatDeltaEvent, type ChatDoneEvent } from "../shared/ipc";
import { appendMessage, updateMessage } from "./sessions";

let nextId = 0;
const messageId = () => `msg_${Date.now().toString(36)}_${(nextId++).toString(36)}`;

const activeStreams = new Set<() => void>();

export function isStreaming(): boolean {
  return activeStreams.size > 0;
}

export function buildReply(prompt: string): string {
  const trimmed = prompt.trim();
  if (/^(你好|hello|hi|嗨)/i.test(trimmed)) {
    return `你好！我是 InnocenceCode 的本地助手。我目前是一个 **mock 后端**，用来演示客户端的完整交互链路：\n\n- 流式输出（逐 token 渲染）\n- 会话管理（新建 / 删除 / 自动重命名）\n- 主题跟随系统（dark / light）\n\n把 \`src/main/mockAgent.ts\` 换成真实模型接口，界面无需任何改动。`;
  }
  if (/(代码|code|函数|function|示例)/i.test(trimmed)) {
    return `下面是一个示例实现：\n\n\`\`\`ts\n// 防抖：在停止输入 wait 毫秒后执行 fn\nexport function debounce<A extends unknown[]>(\n  fn: (...args: A) => void,\n  wait = 200,\n): (...args: A) => void {\n  let timer: ReturnType<typeof setTimeout> | undefined;\n  return (...args: A) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), wait);\n  };\n}\n\`\`\`\n\n要点：\n\n1. 用泛型保留原函数的参数类型\n2. \`clearTimeout\` 对 \`undefined\` 是安全的\n3. 需要立即执行的版本可以加 leading 选项`;
  }
  if (/(electron|主进程|ipc)/i.test(trimmed)) {
    return `这个客户端的进程模型：\n\n- **主进程**：\`src/main/\`，负责窗口、菜单、自定义 \`innocencecode://\` 协议和会话存储\n- **Preload**：\`src/preload/\`，用 \`contextBridge\` 暴露最小 API，\`sandbox: true\` + \`contextIsolation: true\`\n- **渲染进程**：\`src/webview/\`，React + Tailwind，只通过 preload 桥通信\n\nIPC 契约集中在 \`src/shared/ipc.ts\`，两侧共享同一份类型定义。`;
  }
  return `收到：「${trimmed.slice(0, 80)}${trimmed.length > 80 ? "…" : ""}」\n\n我是本地 mock 模型，不会真正理解这段话，但会按流式协议完整走一遍响应流程。\n\n可以试试问我：\n\n- 「写一段防抖代码」\n- 「介绍一下这个客户端的架构」\n- 或者随便打个招呼`;
}

export function startStream(
  win: BrowserWindow,
  sessionId: string,
  prompt: string,
): string {
  const id = messageId();
  appendMessage(sessionId, {
    id,
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    streaming: true,
  });

  const reply = buildReply(prompt);
  const tokens = reply.match(/\s*\S+/g) ?? [reply];
  let index = 0;
  let buffer = "";
  let cancelled = false;

  const timer = setInterval(() => {
    if (cancelled) return;
    // 2 tokens per tick keeps the stream lively without hogging the channel.
    const chunk = tokens.slice(index, index + 2).join("");
    index += 2;
    buffer += chunk;
    const event: ChatDeltaEvent = { sessionId, messageId: id, delta: chunk };
    if (!win.isDestroyed()) win.webContents.send(IPC.chatDelta, event);
    if (index >= tokens.length) finish();
  }, 30);

  const cleanup = () => {
    cancelled = true;
    clearInterval(timer);
    activeStreams.delete(cleanup);
  };
  activeStreams.add(cleanup);

  const finish = () => {
    cleanup();
    updateMessage(sessionId, id, { streaming: false, content: buffer });
    const done: ChatDoneEvent = { sessionId, messageId: id };
    if (!win.isDestroyed()) win.webContents.send(IPC.chatDone, done);
  };

  return id;
}

export function stopStream(sessionId: string, messageId: string): void {
  for (const cancel of activeStreams) cancel();
  updateMessage(sessionId, messageId, { streaming: false });
}
