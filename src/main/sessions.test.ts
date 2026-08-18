// Session store persistence: index round-trips, retitle/reorder rules,
// transcript hydration and deletion — all against a temp dir, no electron.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
      content: "帮我修一个登录 bug\n第二行不进标题",
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
    appendMessage(s.id, { id: "m1", role: "user", content: "第一条", createdAt: 1 });
    appendMessage(s.id, { id: "m2", role: "assistant", content: "回复", createdAt: 2 });
    appendMessage(s.id, { id: "m3", role: "user", content: "第二条", createdAt: 3 });
    expect(listSessions()[0].title).toBe("第一条");
    expect(listSessions()[0].messageCount).toBe(3);
  });

  it("hydrates messages from the JSONL transcript, text parts only", () => {
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
          // Tool results arrive as user-role parts with no text — filtered out.
          { role: "user", parts: [{ type: "toolResult", content: "file body" }] },
        ],
      }),
    ];
    writeFileSync(path.join(dir, "transcripts", `${s.id}.jsonl`), `${lines.join("\n")}\n`, "utf8");

    // Simulate a restart so hydration (not the live array) is exercised.
    initSessionStore(dir);
    const messages = listMessages(s.id);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "你好，有什么可以帮你？"],
    ]);
    expect(messages[1].createdAt).toBe(Date.parse("2026-08-18T10:00:05.000Z"));
    expect(listSessions()[0].messageCount).toBe(2);
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
