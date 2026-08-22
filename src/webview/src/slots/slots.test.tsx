// @vitest-environment jsdom
// 槽位系统契约测试：registry 纯逻辑语义 + 视图层挂载/卸载与订阅重渲染。
// 语义来源：任务简报（single 后注覆盖 / list 保序 / keyed 精确+前缀最长+priority 遮蔽）。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createSlotRegistry } from "./registry";
import {
  SlotProvider,
  useRegisterKeyed,
  useRegisterList,
  useRegisterSingle,
  useSingleSlot,
  useSlotKeyedResolve,
  useSlotList,
} from "./react";
import type { KeyedContribution } from "./types";

afterEach(cleanup);

describe("createSlotRegistry 纯逻辑", () => {
  it("single：后注覆盖先注；撤覆盖者回落；撤被覆盖者不误撤后来者；二次注销无害", () => {
    const registry = createSlotRegistry();
    const slot = registry.single<string>("status");
    const offA = slot.register("a");
    expect(slot.get()).toBe("a");
    const offB = slot.register("b");
    expect(slot.get()).toBe("b");
    offB();
    expect(slot.get()).toBe("a");
    offB();
    expect(slot.get()).toBe("a");
    const offC = slot.register("c");
    offA();
    expect(slot.get()).toBe("c");
    offC();
    expect(slot.get()).toBeUndefined();
  });

  it("single：同 slot 标识重复取用共享同一状态", () => {
    const registry = createSlotRegistry();
    registry.single<string>("status").register("v");
    expect(registry.single<string>("status").get()).toBe("v");
  });

  it("list：注册序保序；按条目注销；后注追加尾部；二次注销无害", () => {
    const registry = createSlotRegistry();
    const slot = registry.list<string>("items");
    const offX = slot.register("x");
    slot.register("y");
    expect(slot.all()).toEqual(["x", "y"]);
    offX();
    offX();
    expect(registry.list<string>("items").all()).toEqual(["y"]);
    slot.register("z");
    expect(slot.all()).toEqual(["y", "z"]);
  });

  it("list：快照身份在未变更时稳定（外部存储订阅前提），变更后失效", () => {
    const registry = createSlotRegistry();
    const slot = registry.list<string>("items");
    slot.register("x");
    const first = slot.all();
    expect(registry.list<string>("items").all()).toBe(first);
    slot.register("y");
    expect(slot.all()).not.toBe(first);
  });

  it("keyed：精确 key 命中优先于前缀条目；无命中返回 undefined", () => {
    const registry = createSlotRegistry();
    const slot = registry.keyed<string>("cards");
    slot.register({ key: "prefix:mcp__", value: "prefix-card" });
    slot.register({ key: "mcp__github", value: "exact-card" });
    expect(slot.resolve("mcp__github")).toBe("exact-card");
    expect(slot.resolve("mcp__other")).toBe("prefix-card");
    expect(slot.resolve("plain")).toBeUndefined();
  });

  it("keyed：前缀取最长匹配；等长前缀按 priority 遮蔽", () => {
    const registry = createSlotRegistry();
    const slot = registry.keyed<string>("cards");
    slot.register({ key: "prefix:mcp__", value: "short-lo" });
    slot.register({ key: "prefix:mcp__", priority: 5, value: "short-hi" });
    slot.register({ key: "prefix:mcp__x", value: "long" });
    expect(slot.resolve("mcp__xyz")).toBe("long");
    expect(slot.resolve("mcp__abc")).toBe("short-hi");
  });

  it("keyed：同 key 高 priority 遮蔽；同 priority 后注胜；撤遮蔽者回落；不误撤同 key 后来者", () => {
    const registry = createSlotRegistry();
    const slot = registry.keyed<string>("cards");
    const offLow = slot.register({ key: "k", priority: 1, value: "low" });
    const offHigh = slot.register({ key: "k", priority: 10, value: "high" });
    slot.register({ key: "k", value: "tail" });
    expect(slot.resolve("k")).toBe("high");
    offLow();
    expect(slot.resolve("k")).toBe("high");
    const offTwin = slot.register({ key: "k", priority: 10, value: "high2" });
    expect(slot.resolve("k")).toBe("high2");
    offTwin();
    expect(slot.resolve("k")).toBe("high");
    offHigh();
    offTwin();
    expect(slot.resolve("k")).toBe("tail");
  });
});

describe("槽位视图层绑定", () => {
  function KeyedReader({ slot, name }: { slot: string; name: string }) {
    const value = useSlotKeyedResolve<string>(slot, name);
    return <span data-testid="keyed">{value ?? "<none>"}</span>;
  }

  function KeyedRegistrar({ slot, entry }: { slot: string; entry: KeyedContribution<string> }) {
    useRegisterKeyed(slot, entry);
    return null;
  }

  function SingleRegistrar({ slot, value }: { slot: string; value: string }) {
    useRegisterSingle(slot, value);
    return null;
  }

  function ListRegistrar({ slot, value }: { slot: string; value: string }) {
    useRegisterList(slot, value);
    return null;
  }

  function SingleReader({ slot }: { slot: string }) {
    const value = useSingleSlot<string>(slot);
    return <span data-testid="single">{value ?? "<none>"}</span>;
  }

  function ListReader({ slot }: { slot: string }) {
    const items = useSlotList<string>(slot);
    return <span data-testid="list">{items.join("|") || "<empty>"}</span>;
  }

  it("keyed 挂载-卸载零残留：撤遮蔽注册后 resolve 回落，重挂载再次遮蔽", () => {
    function Harness() {
      const [overlay, setOverlay] = useState(true);
      return (
        <SlotProvider>
          <KeyedRegistrar slot="cards" entry={{ key: "k", priority: 1, value: "base" }} />
          {overlay && <KeyedRegistrar slot="cards" entry={{ key: "k", priority: 9, value: "overlay" }} />}
          <KeyedReader slot="cards" name="k" />
          <button type="button" onClick={() => setOverlay((v) => !v)}>
            toggle
          </button>
        </SlotProvider>
      );
    }
    render(<Harness />);
    expect(screen.getByTestId("keyed").textContent).toBe("overlay");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("keyed").textContent).toBe("base");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("keyed").textContent).toBe("overlay");
  });

  it("single/list 挂载-卸载零残留（含严格模式双调用幂等）", () => {
    function Harness() {
      const [extra, setExtra] = useState(true);
      return (
        <StrictMode>
          <SlotProvider>
            <SingleRegistrar slot="title" value="base" />
            {extra && <SingleRegistrar slot="title" value="extra" />}
            <ListRegistrar slot="items" value="core" />
            {extra && <ListRegistrar slot="items" value="extra-item" />}
            <SingleReader slot="title" />
            <ListReader slot="items" />
            <button type="button" onClick={() => setExtra((v) => !v)}>
              toggle
            </button>
          </SlotProvider>
        </StrictMode>
      );
    }
    render(<Harness />);
    expect(screen.getByTestId("single").textContent).toBe("extra");
    expect(screen.getByTestId("list").textContent).toBe("core|extra-item");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("single").textContent).toBe("base");
    expect(screen.getByTestId("list").textContent).toBe("core");
  });

  it("命令式注册/注销经槽位订阅触发读取组件重渲染", () => {
    const registry = createSlotRegistry();
    render(
      <SlotProvider registry={registry}>
        <SingleReader slot="title" />
        <ListReader slot="items" />
        <KeyedReader slot="cards" name="mcp__x" />
      </SlotProvider>,
    );
    expect(screen.getByTestId("single").textContent).toBe("<none>");
    expect(screen.getByTestId("list").textContent).toBe("<empty>");
    expect(screen.getByTestId("keyed").textContent).toBe("<none>");
    let offTitle = () => {};
    act(() => {
      offTitle = registry.single<string>("title").register("t1");
      registry.list<string>("items").register("a");
      registry.keyed<string>("cards").register({ key: "prefix:mcp__", value: "card" });
    });
    expect(screen.getByTestId("single").textContent).toBe("t1");
    expect(screen.getByTestId("list").textContent).toBe("a");
    expect(screen.getByTestId("keyed").textContent).toBe("card");
    act(() => {
      offTitle();
    });
    expect(screen.getByTestId("single").textContent).toBe("<none>");
  });
});
