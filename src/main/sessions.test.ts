// Session store persistence: index round-trips, retitle/reorder rules,
// transcript hydration and deletion — all against a temp dir, no electron.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendMessage,
  createSession,
  deleteSession,
  initSessionStore,
  listMessages,
  listSessions,
} from "./sessions";
import { appendText, messageText } from "../shared/ipc";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ic-sessions-"));
  initSessionStore(dir);
});

function indexEntries(): unknown[] {
  return JSON.parse(readFileSync(path.join(dir, "sessions.json"), "utf8")) as unknown[];
}

describe("session store persistence", () => {
  it("creates a session immediately and survives a restart (re-init)", () => {
    const session = createSession();
    expect(session.title).toBe("新会话");
    expect(listSessions().map((s) => s.id)).toEqual([session.id]);

    initSessionStore(dir); // simulate app restart
    const restored = listSessions();
    expect(restored.map((s) => s.id)).toEqual([session.id]);
    expect(restored[0].title).toBe("新会话");
    expect(restored[0].messageCount).toBe(0);
  });

  it("workspaceRoot 随会话持久化并在重启后恢复（空值兜底为空串）", () => {
    const withProject = createSession({ workspaceRoot: "D:/x/alpha" });
    const without = createSession();
    initSessionStore(dir); // restart
    const restored = listSessions();
    const a = restored.find((s) => s.id === withProject.id)!;
    const b = restored.find((s) => s.id === without.id)!;
    expect(a.workspaceRoot).toBe("D:/x/alpha");
    expect(b.workspaceRoot ?? "").toBe("");
  });

  it("corrupt transcript (NUL-filled after power loss) heals aside + surfaces a notice, not a silent blank", () => {    const session = createSession();
    mkdirSync(path.join(dir, "transcripts"), { recursive: true });
    writeFileSync(path.join(dir, "transcripts", `${session.id}.jsonl`), "\u0000".repeat(512), "utf8");
    initSessionStore(dir); // restart → hydrate hits the corrupt file
    const msgs = listMessages(session.id);
    expect(msgs).toHaveLength(1);
    expect(messageText(msgs[0]!.parts)).toContain("会话记录损坏");
    const leftover = readdirSync(path.join(dir, "transcripts")).filter(
      (f) => f.startsWith(session.id) && f.includes(".corrupt-"),
    );
    expect(leftover).toHaveLength(1); // 坏文件已移开，后续追加写入新文件
  });

  it("keeps display order and newest-first on create", () => {
    const first = createSession();
    const second = createSession();
    expect(listSessions().map((s) => s.id)).toEqual([second.id, first.id]);
  });

  it("retitles from the first user message, moves to front, and persists both", () => {
    const a = createSession();
    const b = createSession();
    appendMessage(a.id, {
      id: "msg_u1",
      role: "user",
      parts: [{ type: "text", text: "帮我修一个登录 bug\n第二行不进标题" }],
      createdAt: Date.now(),
    });

    const listed = listSessions();
    expect(listed[0].id).toBe(a.id); // promoted to front
    expect(listed[0].title).toBe("帮我修一个登录 bug");
    expect(listed[0].messageCount).toBe(1);
    expect(listed[1].id).toBe(b.id);

    initSessionStore(dir); // restart keeps title + order
    const restored = listSessions();
    expect(restored[0].title).toBe("帮我修一个登录 bug");
    expect(restored.map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it("does not retitle once the session has a real title", () => {
    const s = createSession();
    appendMessage(s.id, { id: "m1", role: "user", parts: [{ type: "text", text: "第一条" }], createdAt: 1 });
    appendMessage(s.id, { id: "m2", role: "assistant", parts: [{ type: "text", text: "回复" }], createdAt: 2 });
    appendMessage(s.id, { id: "m3", role: "user", parts: [{ type: "text", text: "第二条" }], createdAt: 3 });
    expect(listSessions()[0].title).toBe("第一条");
    expect(listSessions()[0].messageCount).toBe(3);
  });

  it("hydrates messages from the JSONL transcript, keeping tool parts", () => {
    const s = createSession();
    mkdirSync(path.join(dir, "transcripts"), { recursive: true });
    const lines = [
      JSON.stringify({
        at: "2026-08-18T10:00:00.000Z",
        type: "turn",
        user: "hi",
        history: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
      "{broken json line",
      JSON.stringify({
        at: "2026-08-18T10:00:05.000Z",
        type: "turn",
        user: "hi",
        history: [
          { role: "user", parts: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            parts: [
              { type: "text", text: "你好，" },
              { type: "toolCall", id: "c1", toolName: "fs.read", args: {} },
              { type: "text", text: "有什么可以帮你？" },
            ],
          },
          // Tool results arrive as their own user-role turn with no text
          // (loop.ts pushes { role: "user", parts: resultParts }) — the
          // hydrate merge folds them into the preceding assistant message to
          // match the live stream's shape.
          { role: "user", parts: [{ type: "toolResult", content: "file body" }] },
        ],
      }),
    ];
    writeFileSync(path.join(dir, "transcripts", `${s.id}.jsonl`), `${lines.join("\n")}\n`, "utf8");

    // Simulate a restart so hydration (not the live array) is exercised.
    initSessionStore(dir);
    const messages = listMessages(s.id);
    // No empty user bubble: the tool-result turn merged into the assistant message.
    expect(messages.map((m) => [m.role, messageText(m.parts)])).toEqual([
      ["user", "hi"],
      ["assistant", "你好，有什么可以帮你？"],
    ]);
    expect(messages[1].parts).toHaveLength(4);
    expect(messages[1].parts[1]).toMatchObject({ type: "toolCall", toolName: "fs.read" });
    expect(messages[1].parts[3]).toMatchObject({ type: "toolResult", content: "file body" });
    expect(messages[1].createdAt).toBe(Date.parse("2026-08-18T10:00:05.000Z"));
    expect(listSessions()[0].messageCount).toBe(2);
  });

  it("hydrate 保留 toolCall/toolResult parts 并按 live 形状配对", () => {
    const s = createSession();
    mkdirSync(path.join(dir, "transcripts"), { recursive: true });
    writeFileSync(
      path.join(dir, "transcripts", `${s.id}.jsonl`),
      JSON.stringify({
        at: new Date().toISOString(),
        type: "turn",
        history: [
          { role: "user", parts: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            parts: [
              { type: "thinking", text: "先看目录" },
              { type: "text", text: "看下" },
              { type: "toolCall", id: "t1", toolName: "Bash", args: { command: "ls" } },
            ],
          },
          // Real transcript shape: tool results live in a follow-up user turn
          // with no text (loop.ts pushes { role: "user", parts: resultParts }).
          {
            role: "user",
            parts: [{ type: "toolResult", toolCallId: "t1", content: "a.txt", isError: false }],
          },
        ],
      }) + "\n",
      "utf8",
    );
    // Restart so hydration (not the live array) is exercised.
    initSessionStore(dir);
    const msgs = listMessages(s.id);
    // The tool-result turn merges into the assistant message — no empty user bubble.
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const parts = msgs[1].parts;
    expect(parts).toHaveLength(4);
    expect(parts[0]).toMatchObject({ type: "thinking", text: "先看目录" });
    expect(parts[1]).toMatchObject({ type: "text", text: "看下" });
    // toolCall and toolResult sit adjacent in one message so pairTools pairs them.
    expect(parts[2]).toMatchObject({ type: "toolCall", id: "t1", toolName: "Bash" });
    expect(parts[3]).toMatchObject({ type: "toolResult", toolCallId: "t1", content: "a.txt" });
    expect(listSessions().find((x) => x.id === s.id)?.messageCount).toBe(2);

    // Defensive: a textless user turn with no preceding assistant message
    // survives as its own message instead of being dropped or lost.
    const s2 = createSession();
    writeFileSync(
      path.join(dir, "transcripts", `${s2.id}.jsonl`),
      JSON.stringify({
        at: new Date().toISOString(),
        type: "turn",
        history: [
          {
            role: "user",
            parts: [{ type: "toolResult", toolCallId: "x", content: "orphan", isError: true }],
          },
        ],
      }) + "\n",
      "utf8",
    );
    initSessionStore(dir);
    const orphan = listMessages(s2.id);
    expect(orphan).toHaveLength(1);
    expect(orphan[0].role).toBe("user");
    expect(orphan[0].parts[0]).toMatchObject({ type: "toolResult", content: "orphan" });
  });

  it("returns empty messages for a session without transcript", () => {
    const s = createSession();
    initSessionStore(dir);
    expect(listMessages(s.id)).toEqual([]);
  });

  it("deletes the session, its index entry and its transcript file", () => {
    const s = createSession();
    mkdirSync(path.join(dir, "transcripts"), { recursive: true });
    const transcript = path.join(dir, "transcripts", `${s.id}.jsonl`);
    writeFileSync(transcript, "{}\n", "utf8");

    deleteSession(s.id);
    expect(listSessions()).toEqual([]);
    expect(existsSync(transcript)).toBe(false);
    expect(indexEntries()).toEqual([]);

    initSessionStore(dir); // still gone after restart
    expect(listSessions()).toEqual([]);
  });

  it("starts empty when the index file is corrupt", () => {
    writeFileSync(path.join(dir, "sessions.json"), "not json{{{", "utf8");
    initSessionStore(dir);
    expect(listSessions()).toEqual([]);
  });
});

describe("message parts helpers", () => {
  it("appendText 续写末尾 text part", () => {
    const parts = appendText([{ type: "text", text: "a" }], "b");
    expect(messageText(parts)).toBe("ab");
    expect(parts).toHaveLength(1);
  });
  it("appendText 在工具 part 后新开 text", () => {
    const parts = appendText([{ type: "toolCall", id: "c1", toolName: "Bash", args: {} }], "x");
    expect(parts).toHaveLength(2);
    expect(messageText(parts)).toBe("x");
  });
});
