# kernel — 自研插件内核（context / fiber / effects / events）

`@innocencecode/kernel` 是一套独立的通用插件运行时内核：以 `Context`（根容器）+ `Fiber`（插件生命周期状态机）+
`Registry`（运行时表）+ `EventBus`（同步类型化事件总线）+ `ServiceTable`（具名服务表）构成一棵"上下文树"。
每个插件运行在自己的 fiber 中，用 effect 收集清理函数，卸载时逆序回卷。

配置树加载器在 `@innocencecode/kernel-loader`，YAML 条目内建在 `@innocencecode/kernel-include`。

> 与 harness 脊柱的关系：Agent 会话（harness-electron 的 session 家）与注册脊柱（harness-tools 等
> `harness-*` 脊柱包）以本内核为底座装载；本包保持独立通用演进，宿主经动态 import 从分发树装载（单实例）。

## 作用

- **Context**：根依赖容器，持有 fiber 树 / registry / 服务表；`derive(fiber)` 派生插件作用域子上下文（仅遮蔽 fiber，其余共享）。
  `on / emit / effect / plugin / provide` 是插件唯一入口。
- **Fiber**：单插件生命周期状态机 `PENDING → LOADING → ACTIVE/FAILED → UNLOADING → DISPOSED`；effect 注册即执行 body，
  返回的 disposer 保证恰好执行一次；生命周期操作按 fiber 串行化，并发 `dispose()` 合并为同一次回卷。
- **Registry**：按"插件回调函数"识别插件（对象插件的 `apply` 方法或裸函数）；同一回调多次加载共享一个 `PluginRuntime` 记录，
  全部 fiber 销毁后才遗忘。
- **EventBus**：订阅本身就是注册者 fiber 的 effect（fiber 卸载自动退订）；派发同步、按注册顺序、对监听器快照遍历。
- **ServiceTable**：`publish` 在根 Context 上安装惰性 getter 访问器（全树可见），返回幂等撤回句柄。
- **KernelError**：稳定错误码（如 `INACTIVE_EFFECT`——在已销毁/卸载中的 fiber 上注册 effect 时抛出）。

## 公开 API（节选）

| 导出 | 说明 |
|---|---|
| `Context` | 根容器：`derive / on / emit / effect / plugin / provide` |
| `Fiber` | 生命周期状态机：`state / uid / parent / ctx / dispose / restart`，`static createRoot` |
| `toAwaitable(fiber)` | 包装 fiber 使其可 `await`（启动完成 resolve，失败 reject） |
| `Registry` | 运行时表：`size / has / get / delete / load(parent, plugin)` |
| `ObjectPlugin` / `FunctionPlugin` / `Plugin` | 插件形状：带 `apply(ctx)` 的对象，或裸函数 |
| `PluginRuntime` | 同一插件回调的共享运行时记录（name / callback / fibers） |
| `EventBus` / `Events` | 同步类型化事件总线；`Events` 接口可经声明合并扩展 |
| `ServiceTable` | 具名服务发布与撤回 |
| `KernelError` / `KernelErrorCode` | 类型化内核错误 |
| `Disposer` / `EffectBody` / `EffectHandle` / `StartupResult` 等 | effect 与启动结果类型 |

插件入口的返回值若是一个函数，它就是该插件的启动清理器（随 fiber 回卷执行）。

## 使用

```ts
import { Context, toAwaitable } from "@innocencecode/kernel";

const root = Context.createRoot({ name: "host" });

const plugin = {
  name: "example",
  apply(ctx) {
    const off = ctx.on("ping", (payload) => console.log(payload)); // 订阅随 fiber 自动退订
    const retract = ctx.provide("greeting", () => "hello");        // 撤回句柄幂等
    return () => { off(); retract(); };                            // 启动清理器（逆序回卷的一员）
  },
};

const fiber = toAwaitable(root.ctx.plugin(plugin)); // 插件入口永不同步执行：先拿到 fiber，可 await 启动
await fiber;                                        // 启动完成
await fiber.dispose();                              // 逆序回卷全部 disposer
```

## 关键行为与约束

- 插件入口排队首次加载，调用者总能先拿到 fiber；`await` 该 fiber 等待启动完成。
- 回卷 = 逆序执行全部 disposer；单个 disposer 抛错不中断其余回卷；每个 disposer 恰好执行一次（句柄调用与 fiber 回卷先到者生效）。
- 根 fiber 的 `dispose()` 等于 `restart()`：清空作用域并回到全新 active 状态；重复销毁是 no-op。
- 父 fiber 卸载连带销毁子 fiber；detach 同步且幂等；在已脱离（uid 为 null）的 fiber 上 `restart()` 抛 `INACTIVE_EFFECT`。
- 服务名不得与 Context 既有成员冲突；`provide` 返回幂等撤回句柄（常由插件入口 return，随 fiber 回卷失效）。

## 测试

```bash
npx vitest run vendor/kernel
```

覆盖：内核语义（`kernel-semantics.spec.ts`）、作用域生命周期（`scope-lifecycle.spec.ts`）、服务发布守卫（`services.spec.ts`）。
