// 内置 Agent 注册表：default 沿用既有提示词（行为不变），plan/full 为
// 完整中文执行协议提示词；systemPromptFor 对未知值回落 default。
import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  BUILTIN_AGENTS,
  DEFAULT_SYSTEM_PROMPT,
  systemPromptFor,
  type AgentId,
} from "../src";

describe("BUILTIN_AGENTS", () => {
  it("三个内置 agent（default/plan/full），id 集与 AGENT_IDS 一致", () => {
    expect(BUILTIN_AGENTS.map((a) => a.id).sort()).toEqual(["default", "full", "plan"]);
    expect(AGENT_IDS).toEqual(BUILTIN_AGENTS.map((a) => a.id));
    for (const a of BUILTIN_AGENTS) {
      expect(a.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("plan/full 提示词为完整文本（>200 字符），三个提示词互异", () => {
    // default 沿用既有 119 字符短文本（行为不变，见下一用例），长度门槛
    // 只约束按规格 2.1 新撰写的 plan/full 执行协议提示词。
    for (const a of BUILTIN_AGENTS) {
      if (a.id === "default") continue;
      expect(a.systemPrompt.trim().length).toBeGreaterThan(200);
    }
    expect(systemPromptFor("full")).not.toBe(systemPromptFor("default"));
    expect(systemPromptFor("plan")).not.toBe(systemPromptFor("default"));
    expect(systemPromptFor("plan")).not.toBe(systemPromptFor("full"));
  });

  it("default 沿用既有 DEFAULT_SYSTEM_PROMPT 原文（行为不变）", () => {
    expect(systemPromptFor("default")).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("systemPromptFor 未知值回落 default", () => {
    expect(systemPromptFor("nope" as AgentId)).toBe(systemPromptFor("default"));
  });
});
