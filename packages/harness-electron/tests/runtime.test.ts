import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockProvider, type MockTurn } from "@innocencecode/provider-mock";
import {
  DEFAULT_SETTINGS,
  HarnessRuntime,
  type AskResponse,
  type HarnessSettings,
  type RuntimeHooks,
} from "../src";

let persistDir: string;
let workspace: string;

interface Recorded {
  deltas: string[];
  completed: number;
  errors: string[];
  asks: Array<{ toolName: string; answer: AskResponse }>;
}

function makeHooks(recorded: Recorded, answer: AskResponse = "allow"): RuntimeHooks {
  return {
    onDelta: (_s, _m, delta) => recorded.deltas.push(delta),
    onCompleted: () => {
      recorded.completed += 1;
    },
    onError: (_s, _m, error) => recorded.errors.push(error),
    askPermission: async (_s, _m, ask) => {
      recorded.asks.push({ toolName: ask.call.toolName, answer });
      return answer;
    },
    log: () => {},
  };
}

function makeRuntime(
  turns: MockTurn[],
  settings: Partial<HarnessSettings> = {},
  recorded: Recorded,
  answer: AskResponse = "allow",
) {
  const full: HarnessSettings = { ...DEFAULT_SETTINGS, ...settings };
  return new HarnessRuntime({
    settings: () => full,
    hooks: makeHooks(recorded, answer),
    persistDir,
    providerFactory: () => createMockProvider({ turns }),
  });
}

beforeAll(async () => {
  persistDir = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-rt-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-ws-"));
  await fs.writeFile(path.join(workspace, "hello.txt"), "hello harness\n", "utf8");
});

afterAll(async () => {
  await fs.rm(persistDir, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("HarnessRuntime", () => {
  it("streams a plain-text turn end-to-end and persists the transcript", async () => {
    const recorded: Recorded = { deltas: [], completed: 0, errors: [], asks: [] };
    const runtime = makeRuntime([{ text: "你好，我是回复" }], { workspaceRoot: workspace }, recorded);

    await runtime.send("sess-1", "打个招呼", "msg_t1");

    expect(recorded.deltas.join("")).toContain("你好，我是回复");
    expect(recorded.completed).toBe(1);
    expect(recorded.errors).toEqual([]);

    const file = path.join(persistDir, "sess-1.jsonl");
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.user).toBe("打个招呼");
    expect(record.history.at(-1).parts[0].text).toContain("你好，我是回复");
  });

  it("runs fs tools against the workspace with a permission ask", async () => {
    const recorded: Recorded = { deltas: [], completed: 0, errors: [], asks: [] };
    const runtime = makeRuntime(
      [
        { toolCalls: [{ toolName: "Read", args: { path: "hello.txt" } }] },
        { text: "读完了" },
      ],
      { workspaceRoot: workspace, permissionMode: "ask" },
      recorded,
      "allow",
    );

    await runtime.send("sess-2", "读 hello.txt", "msg_t2");

    expect(recorded.asks).toEqual([{ toolName: "Read", answer: "allow" }]);
    const joined = recorded.deltas.join("");
    expect(joined).toContain("🔧 **Read**");
    expect(joined).toContain("hello harness");
    expect(joined).toContain("读完了");
    expect(recorded.completed).toBe(1);
  });

  it("feeds a denied permission back as an error result the model can see", async () => {
    const recorded: Recorded = { deltas: [], completed: 0, errors: [], asks: [] };
    const runtime = makeRuntime(
      [
        { toolCalls: [{ toolName: "Write", args: { path: "x.txt", content: "nope" } }] },
        { text: "好吧，我不写了" },
      ],
      { workspaceRoot: workspace, permissionMode: "ask" },
      recorded,
      "deny",
    );

    await runtime.send("sess-3", "写 x.txt", "msg_t3");

    expect(recorded.asks).toHaveLength(1);
    const joined = recorded.deltas.join("");
    expect(joined).toContain("❌");
    expect(joined).toContain("好吧，我不写了");
    await expect(fs.access(path.join(workspace, "x.txt"))).rejects.toThrow();
  });

  it("rebuilds the cached agent session when settings change, keeping history", async () => {
    const recorded: Recorded = { deltas: [], completed: 0, errors: [], asks: [] };
    const settings: HarnessSettings = { ...DEFAULT_SETTINGS, workspaceRoot: workspace };
    let currentTurns: MockTurn[] = [{ text: "来自设置A的回复" }];
    const runtime = new HarnessRuntime({
      settings: () => settings,
      hooks: makeHooks(recorded),
      persistDir,
      providerFactory: () => createMockProvider({ turns: currentTurns }),
    });

    await runtime.send("sess-4", "一", "msg_t4a");
    // Same runtime, new settings hash -> cached session rebuilt with the
    // previous conversation carried over, new provider takes effect.
    currentTurns = [{ text: "来自设置B的回复" }];
    settings.permissionMode = "plan";
    await runtime.send("sess-4", "二", "msg_t4b");

    const joined = recorded.deltas.join("");
    expect(joined).toContain("来自设置A的回复");
    expect(joined).toContain("来自设置B的回复");
    expect(recorded.completed).toBe(2);
  });
});
