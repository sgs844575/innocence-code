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
  type LiveToolPart,
  type RuntimeHooks,
} from "../src";

/**
 * M6 stand-in for the self-bootstrap acceptance: the full runtime stack
 * (sessions, permission asks, fs + shell tools, transcripts) executes a
 * realistic agent workflow — read an existing file, patch it, write a new
 * module, verify it by running node — without any network or real LLM.
 */
describe("agent workflow end-to-end (bootstrap stand-in)", () => {
  let workspace: string;
  let persistDir: string;

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-boot-"));
    persistDir = await fs.mkdtemp(path.join(os.tmpdir(), "innocence-boot-t-"));
    await fs.writeFile(
      path.join(workspace, "feature.mjs"),
      "export function add(a, b) {\n  return a + b;\n}\n",
      "utf8",
    );
  });

  afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(persistDir, { recursive: true, force: true });
  });

  it("runs read -> edit -> write -> verify through permission gates", async () => {
    const asks: string[] = [];
    const deltas: string[] = [];
    const tools: LiveToolPart[] = [];
    const hooks: RuntimeHooks = {
      onDelta: (_s, _m, d) => deltas.push(d),
      onTool: (_s, _m, part) => tools.push(part),
      onThinking: () => {},
      onCompleted: () => {},
      onError: (_s, _m, e) => {
        throw new Error(`unexpected harness error: ${e}`);
      },
      askPermission: async (_s, _m, ask) => {
        asks.push(ask.call.toolName);
        return "allow" as AskResponse;
      },
      log: () => {},
    };
    const settings: HarnessSettings = {
      ...DEFAULT_SETTINGS,
      workspaceRoot: workspace,
      permissionMode: "ask",
    };

    const turns: MockTurn[] = [
      { toolCalls: [{ toolName: "Read", args: { path: "feature.mjs" } }] },
      {
        toolCalls: [
          {
            toolName: "Edit",
            args: {
              path: "feature.mjs",
              old_string: "return a + b;",
              new_string: "return a + b + 1;",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "Write",
            args: {
              path: "feature.test.mjs",
              content:
                "import { add } from './feature.mjs';\n" +
                "if (add(1, 2) !== 4) { throw new Error('add(1,2) should be 4 after patch'); }\n" +
                "console.log('feature ok');\n",
            },
          },
        ],
      },
      {
        toolCalls: [
          { toolName: "Bash", args: { command: "node feature.test.mjs" } },
        ],
      },
      { text: "补丁完成：add 现在偏移 +1，验证脚本输出 feature ok。" },
    ];

    const runtime = new HarnessRuntime({
      settings: () => settings,
      hooks,
      persistDir,
      providerFactory: () => createMockProvider({ turns }),
    });

    await runtime.send("boot-sess", "给 feature.mjs 打补丁并验证", "msg_boot");

    // The patched file and the new test exist in the real workspace.
    const patched = await fs.readFile(path.join(workspace, "feature.mjs"), "utf8");
    expect(patched).toContain("a + b + 1");
    await fs.access(path.join(workspace, "feature.test.mjs"));

    // Every tool went through an approval ask.
    expect(asks).toEqual(["Read", "Edit", "Write", "Bash"]);

    // The UI stream shows the final text; tool activity arrives structured.
    const joined = deltas.join("");
    expect(joined).toContain("补丁完成");
    expect(tools.some((p) => p.type === "toolCall" && p.toolName === "Edit")).toBe(
      true,
    );
    expect(
      tools.some((p) => p.type === "toolResult" && p.content.includes("feature ok")),
    ).toBe(true);

    // The transcript captured the full turn.
    const transcript = await fs.readFile(
      path.join(persistDir, "boot-sess.jsonl"),
      "utf8",
    );
    expect(transcript).toContain("给 feature.mjs 打补丁并验证");
  });
});
