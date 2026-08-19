// Drift guard：shared 的 PROVIDER_PRESET_MIRROR 必须与 harness-electron 的
// PROVIDER_PRESETS 逐家对齐（渲染层无法 import node 侧包，镜像一旦漂移，
// AddProviderDialog 展示/创建的预设就会与出厂默认不一致）。
import { describe, expect, it } from "vitest";
import {
  MOCK_MODEL,
  MOCK_PROFILE_ID,
  PROVIDER_PRESET_MIRROR,
  type AgentId,
  type ChatPermissionEvent,
} from "../../../src/shared/ipc";
import type { PermissionResource } from "@innocencecode/harness-core";
import {
  MOCK_MODEL as PKG_MOCK_MODEL,
  MOCK_PROFILE_ID as PKG_MOCK_PROFILE_ID,
  PROVIDER_PRESETS,
} from "../src/settings";
import { AGENT_IDS, BUILTIN_AGENTS, type AgentId as PkgAgentId } from "../src/agents";
import { PRESET_MODELS } from "../src/modelPresets";

describe("PROVIDER_PRESET_MIRROR 对齐 PROVIDER_PRESETS", () => {
  it("厂家集合一致（无缺漏、无多余）", () => {
    expect(PROVIDER_PRESET_MIRROR.map((p) => p.name)).toEqual(PROVIDER_PRESETS.map((p) => p.name));
  });
  it("每家 name/kind/baseURL/models 逐一相等", () => {
    expect(PROVIDER_PRESET_MIRROR).toEqual(PROVIDER_PRESETS);
  });
});

describe("PRESET_MODELS 键对齐 PROVIDER_PRESETS", () => {
  it("元数据键 ⊆ 预设厂家名（键拼错 = enrich 永远 miss）", () => {
    const names = new Set(PROVIDER_PRESETS.map((p) => p.name));
    for (const key of Object.keys(PRESET_MODELS)) {
      expect(names.has(key), `PRESET_MODELS 键 "${key}" 不在任何预设厂家名里`).toBe(true);
    }
  });
  it("每家预设 seed 模型都有元数据（seed 无元数据 = 出厂裸模型）", () => {
    for (const preset of PROVIDER_PRESETS) {
      const meta = PRESET_MODELS[preset.name] ?? {};
      for (const id of preset.models) {
        expect(meta[id], `${preset.name} 的 seed 模型 "${id}" 缺元数据`).toBeDefined();
      }
    }
  });
});

describe("shared 与包内 mock 常量对齐", () => {
  it("MOCK_PROFILE_ID / MOCK_MODEL 一致", () => {
    expect(MOCK_PROFILE_ID).toBe(PKG_MOCK_PROFILE_ID);
    expect(MOCK_MODEL).toBe(PKG_MOCK_MODEL);
  });
});

describe("shared AgentId 镜像对齐 harness-electron agents.ts", () => {
  // shared 不 import 包，AgentId 手工镜像：包内新增 agent 而忘了同步 shared
  // 时，这里的类型赋值与集合断言都会把漂移拦下来。
  it("BUILTIN_AGENTS 的 id 集合与 shared AgentId 一一对应", () => {
    const sharedIds: AgentId[] = BUILTIN_AGENTS.map((a) => a.id);
    expect([...sharedIds].sort()).toEqual(["default", "full", "plan"]);
    expect(AGENT_IDS).toEqual(sharedIds);
  });
  it("类型漂移守卫：shared 镜像与包内 AgentId 双向兼容", () => {
    const shared: AgentId = "plan";
    const pkg: PkgAgentId = shared;
    const back: AgentId = pkg;
    expect(back).toBe("plan");
  });
});

describe("ChatPermissionEvent.resource 对齐 harness-core PermissionResource", () => {
  // 脱敏持久化形状：host 桥只透传 kind/action/scope（metadata 为后续
  // schema 脱敏预留的可选面），shared 不 import 包，靠双向赋值防漂移。
  const event: ChatPermissionEvent = {
    sessionId: "s1",
    messageId: "m1",
    requestId: "p1",
    toolName: "Write",
    args: { path: "src/a.ts" },
    resource: { kind: "file", action: "write", scope: "src/a.ts" },
  };

  it("持久化形状：kind/action/scope 直达", () => {
    expect(event.resource.kind).toBe("file");
    expect(event.resource.action).toBe("write");
    expect(event.resource.scope).toBe("src/a.ts");
  });

  it("类型漂移守卫：shared 镜像与 core PermissionResource 双向兼容", () => {
    const core: PermissionResource = event.resource;
    const mirror: ChatPermissionEvent["resource"] = core;
    expect(core).toEqual({ action: "write", kind: "file", scope: "src/a.ts" });
    expect(mirror.scope).toBe("src/a.ts");
  });
});
