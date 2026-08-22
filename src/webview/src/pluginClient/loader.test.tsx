// @vitest-environment jsdom
// 插件 client 装载器（loader）：清单过滤（active+client）→ 协议 URL 动态
// import → default(api) 注册；失败隔离（warn 含插件 id 不阻断其余）、无
// default 跳过、同注册表重装载先撤销旧注册；末组为 jsdom 集成——真实示例
// client 模块经 mock importModule 装载后渲染 fake ToolCallPart。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import type { PluginInventoryEntry, ToolCallPart, ToolResultPart } from "../../../shared/ipc";
import { SlotProvider } from "../slots/react";
import { createSlotRegistry, type SlotRegistry } from "../slots/registry";
import { getToolCard, TOOLCARD_SLOT, type ToolCardProps } from "../components/chat/toolcards/registry";
import registerExampleClient from "../../../../packages/plugin-example/src/client";
import { loadPluginClients, type PluginClientModule } from "./loader";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const entry = (id: string, over: Partial<PluginInventoryEntry> = {}): PluginInventoryEntry => ({
  id,
  title: id,
  core: false,
  client: true,
  state: "active",
  via: "default",
  ...over,
});

const resolveCard = (registry: SlotRegistry, name: string): ComponentType<ToolCardProps> | undefined =>
  registry.keyed<ComponentType<ToolCardProps>>(TOOLCARD_SLOT).resolve(name);

/** 渲染期探针：Provider 内按名解析卡并渲染（与 toolcards.test 同款）。 */
function CardProbe({ name, ...card }: { name: string } & ToolCardProps): React.JSX.Element {
  const Card = getToolCard(name);
  return <Card {...card} />;
}

const call = (toolName: string, args: Record<string, unknown>): ToolCallPart =>
  ({ type: "toolCall", id: "c1", toolName, args });
const res = (content: string, over: Partial<ToolResultPart> = {}): ToolResultPart =>
  ({ type: "toolResult", toolCallId: "c1", content, isError: false, durationMs: 500, ...over });

describe("loadPluginClients", () => {
  it("成功链：active+client 条目按协议 URL 装载，default(api) 的注册进槽位", async () => {
    const registry = createSlotRegistry();
    const urls: string[] = [];
    await loadPluginClients({
      inventory: [entry("example")],
      registry,
      importModule: async (url) => {
        urls.push(url);
        return { default: (api) => { api.registerToolCard("example", { title: "示例插件卡" }); } };
      },
    });
    // 协议布局与 staging 一致：<id>/dist/client.js（构建产物目录段不可省）。
    expect(urls).toEqual(["innocence-plugin://example/dist/client.js"]);
    expect(resolveCard(registry, "example")).toBeDefined();
  });

  it("失败隔离：importModule 拒绝只 warn 含插件 id，其余条目继续注册", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createSlotRegistry();
    await loadPluginClients({
      inventory: [entry("bad"), entry("good")],
      registry,
      importModule: async (url) => {
        if (url.includes("bad")) throw new Error("boom");
        return { default: (api) => { api.registerToolCard("good", {}); } };
      },
    });
    expect(resolveCard(registry, "good")).toBeDefined();
    expect(resolveCard(registry, "bad")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(" ")).toContain("bad");
  });

  it("无 default 导出或 default 非函数：warn 含 id 并跳过，不阻断其余", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createSlotRegistry();
    await loadPluginClients({
      inventory: [entry("nodefault"), entry("notfn"), entry("good")],
      registry,
      importModule: async (url) => {
        if (url.includes("nodefault")) return {};
        if (url.includes("notfn")) return { default: 42 } as unknown as PluginClientModule;
        return { default: (api) => { api.registerToolCard("good", {}); } };
      },
    });
    expect(resolveCard(registry, "good")).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0].join(" ")).toContain("nodefault");
    expect(warn.mock.calls[1].join(" ")).toContain("notfn");
  });

  it("default(api) 异步拒绝同样隔离（warn 含 id，不阻断其余）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createSlotRegistry();
    await loadPluginClients({
      inventory: [entry("rejects"), entry("good")],
      registry,
      importModule: async (url) =>
        url.includes("rejects")
          ? { default: async () => { throw new Error("register failed"); } }
          : { default: (api) => { api.registerToolCard("good", {}); } },
    });
    expect(resolveCard(registry, "good")).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(" ")).toContain("rejects");
  });

  it("非 active 或非 client 条目不装载（importModule 零调用）", async () => {
    const importModule = vi.fn(async () => ({ default: () => {} }));
    const registry = createSlotRegistry();
    await loadPluginClients({
      inventory: [
        entry("off", { state: "disabled-by-config" }),
        entry("depped", { state: "dependency-disabled" }),
        entry("noclient", { client: false }),
      ],
      registry,
      importModule,
    });
    expect(importModule).not.toHaveBeenCalled();
  });

  it("同注册表重装载先撤销旧注册（清单变化重放，停用条目回落兜底）", async () => {
    const registry = createSlotRegistry();
    const loader = (inventory: PluginInventoryEntry[]) =>
      loadPluginClients({
        inventory,
        registry,
        importModule: async () => ({
          default: (api) => { api.registerToolCard("example", { title: "示例插件卡" }); },
        }),
      });
    await loader([entry("example")]);
    expect(resolveCard(registry, "example")).toBeDefined();
    await loader([entry("example", { state: "disabled-by-config" })]);
    expect(resolveCard(registry, "example")).toBeUndefined();
  });

  it("不同注册表互不干扰（撤销集按注册表隔离）", async () => {
    const a = createSlotRegistry();
    const b = createSlotRegistry();
    const importModule = async () => ({
      default: (api: { registerToolCard: (n: string, d: { title?: string }) => void }) => {
        api.registerToolCard("example", {});
      },
    });
    await loadPluginClients({ inventory: [entry("example")], registry: a, importModule });
    await loadPluginClients({ inventory: [], registry: b, importModule });
    expect(resolveCard(a, "example")).toBeDefined();
  });
});

describe("client 装载集成（jsdom 渲染）", () => {
  it("真实示例 client 装载后渲染 toolName=example 的调用显示 title 徽标", async () => {
    const registry = createSlotRegistry();
    await loadPluginClients({
      inventory: [entry("example")],
      registry,
      importModule: async () => ({ default: registerExampleClient }),
    });
    render(
      <SlotProvider registry={registry}>
        <CardProbe
          name="example"
          call={call("example", { greeting: "hi" })}
          result={res("done")}
          open={true}
          onToggle={() => {}}
        />
      </SlotProvider>,
    );
    expect(screen.getByText("示例插件卡")).toBeTruthy();
    expect(screen.getByText(/"greeting": "hi"/)).toBeTruthy();
    expect(screen.getByText(/done/)).toBeTruthy();
    expect(screen.getByText(/0\.5s/)).toBeTruthy();
  });

  it("折叠态（open=false）不展示参数与结果；停用重装载后回落兜底卡", async () => {
    const registry = createSlotRegistry();
    const importModule = async () => ({ default: registerExampleClient });
    await loadPluginClients({ inventory: [entry("example")], registry, importModule });
    const view = render(
      <SlotProvider registry={registry}>
        <CardProbe
          name="example"
          call={call("example", { greeting: "hi" })}
          result={res("done")}
          open={false}
          onToggle={() => {}}
        />
      </SlotProvider>,
    );
    expect(view.container.textContent).not.toContain('"greeting"');
    expect(view.container.textContent).not.toContain("done");
    // 重装载（示例停用）后同树重渲染：title 徽标消失，兜底卡接管。
    await loadPluginClients({
      inventory: [entry("example", { state: "disabled-by-config" })],
      registry,
      importModule,
    });
    view.rerender(
      <SlotProvider registry={registry}>
        <CardProbe
          name="example"
          call={call("example", { greeting: "hi" })}
          result={res("done")}
          open={true}
          onToggle={() => {}}
        />
      </SlotProvider>,
    );
    expect(screen.queryByText("示例插件卡")).toBeNull();
    expect(screen.getByText("example")).toBeTruthy();
  });

  it("描述符渲染开关：renderArgs/renderResult 关闭时不渲染对应区块", async () => {
    const registry = createSlotRegistry();
    await loadPluginClients({
      inventory: [entry("minimal")],
      registry,
      importModule: async () => ({
        default: (api) => { api.registerToolCard("minimal", { title: "极简卡", renderArgs: false, renderResult: false }); },
      }),
    });
    const view = render(
      <SlotProvider registry={registry}>
        <CardProbe
          name="minimal"
          call={call("minimal", { secret: 1 })}
          result={res("hidden")}
          open={true}
          onToggle={() => {}}
        />
      </SlotProvider>,
    );
    expect(screen.getByText("极简卡")).toBeTruthy();
    expect(view.container.textContent).not.toContain('"secret"');
    expect(view.container.textContent).not.toContain("hidden");
  });
});
