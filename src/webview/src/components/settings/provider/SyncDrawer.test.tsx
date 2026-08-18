// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, ProviderProfile } from "../../../../../shared/ipc";
import { SyncDrawer } from "./SyncDrawer";
import { applySyncPlan } from "./profileOps";
import type { SyncPlan } from "./mergeSync";

afterEach(cleanup);

const mk = (models: string[]): ProviderProfile => ({
  id: "p1",
  name: "智谱开放平台",
  kind: "openai",
  apiKey: "",
  baseURL: "",
  enabled: true,
  models: models.map((id): ModelInfo => ({ id, source: "preset" })),
});
const lookup = (_n: string, id: string): ModelInfo => ({ id, source: "preset", contextWindow: 128000 });

describe("SyncDrawer 单条操作", () => {
  it("单条添加：最终集合 = 本地 + 仅目标模型，且不关闭抽屉", async () => {
    const onApply = vi.fn();
    const listModels = vi.fn().mockResolvedValue(["a", "b", "c"]);
    render(
      <SyncDrawer open profile={mk(["a"])} onClose={() => {}} listModels={listModels} onApply={onApply} modelFromPreset={lookup} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "添加 b" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const plan = onApply.mock.calls[0]![0] as SyncPlan;
    expect(applySyncPlan(plan).map((m) => m.id)).toEqual(["a", "b"]);
    expect(onApply.mock.calls[0]![1]).toBeUndefined(); // 单条操作保持抽屉打开
  });

  it("主按钮'应用全部变更'带 closeAfter", async () => {
    const onApply = vi.fn();
    const listModels = vi.fn().mockResolvedValue(["a", "b"]);
    render(
      <SyncDrawer open profile={mk(["a"])} onClose={() => {}} listModels={listModels} onApply={onApply} modelFromPreset={lookup} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /应用全部变更/ }));
    expect(onApply.mock.calls[0]![1]).toEqual({ closeAfter: true });
  });

  it("单条移除：最终集合 = 本地 − 仅目标失效模型", async () => {
    const onApply = vi.fn();
    const listModels = vi.fn().mockResolvedValue(["a"]);
    render(
      <SyncDrawer open profile={mk(["a", "stale"])} onClose={() => {}} listModels={listModels} onApply={onApply} modelFromPreset={lookup} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "移除 stale" }));
    const plan = onApply.mock.calls[0]![0] as SyncPlan;
    expect(applySyncPlan(plan).map((m) => m.id)).toEqual(["a"]);
  });
});
