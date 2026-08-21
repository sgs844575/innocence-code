# kernel-logger — 内核日志服务插件（LoggerPlugin / LoggerService）

`@innocencecode/kernel-logger` 在内核（`@innocencecode/kernel`）之上提供最小日志服务：
`LoggerPlugin` 是一个内核插件，`apply` 时把 `LoggerService` 以 `"logger"` 之名发布到上下文树
（`ctx.logger`），卸载时随插件 fiber 一起撤回。与 `kernel-include`（YAML 条目）、`kernel-loader`（配置树加载器）
同属 vendor 内核族。

## 作用

- **LoggerService.log(level, message, data?)**：把一条 `LogEntry`（含捕获时间戳）分发给所有过了阈值
  （`minLevel`）的 sink；没有任何 sink 时静默 no-op。
- **LoggerService.addSink(sink, options?)**：注册 sink 并返回退订器；sink 同时挂到插件 fiber 的 effect 上——
  即使从不调用退订器，fiber 回卷也会把它移除。
- **级别过滤**：`debug < info < warn < error`；每个 sink 可设自己的最低级别，缺省 `debug`（全量接收）。

## 公开 API

| 导出 | 说明 |
|---|---|
| `LoggerPlugin` | 内核插件 `{ name: "kernel-logger", apply(ctx) }`；返回 `ctx.provide("logger", …)` 的撤回句柄 |
| `LoggerService` | 服务接口：`log(level, message, data?)` / `addSink(sink, options?) => 退订器` |
| `LogLevel` | `"debug" \| "info" \| "warn" \| "error"` |
| `LogEntry` | `{ level, message, data?, at }`（`at` 为 `Date.now()` 毫秒） |
| `LogSink` | `(entry: LogEntry) => void`；返回值被忽略 |
| `AddSinkOptions` | `{ minLevel?: LogLevel }` |

## 使用

```ts
import { Context } from "@innocencecode/kernel";
import { LoggerPlugin, type LoggerService } from "@innocencecode/kernel-logger";

// 内核把服务安装为运行时属性（defineProperty），类型由使用方通过声明合并补上：
declare module "@innocencecode/kernel" {
  interface Context {
    logger: LoggerService;
  }
}

const ctx = new Context();
await ctx.plugin(LoggerPlugin);

const off = ctx.logger.addSink(
  (e) => console.log(new Date(e.at).toISOString(), e.level, e.message, e.data ?? ""),
  { minLevel: "info" }, // 只收 info 及以上
);
ctx.logger.log("warn", "任务完成", { taskId: "T1" });
off(); // 立即退订（不调也行：fiber 回卷时会移除）
```

## 关键行为与约束

- 分发按注册顺序、对 sink 列表**快照遍历**——sink 在被回调期间增删 sink 不会重排或跳过其余 sink。
- 服务生命周期 = 插件 fiber 生命周期：fiber 卸载后 `ctx.logger` 属性随撤回句柄消失；
  已拿到 service 引用的调用方继续 `log()` 不会抛错（sinks 已被 effect 清空，静默）。
- 退订器幂等：先从列表移除、再解除 effect 挂钩，两条清理路径先到者生效。
- 日志条目只在有 sink 消费时才构造（无 sink 零开销），不缓存、不落盘——持久化由宿主自选 sink 实现。

## 测试

```bash
npx vitest run vendor/kernel-logger
```

`tests/logger.spec.ts` 六个用例：按注册顺序分发、`minLevel` 过滤、退订器退订、服务随 fiber 撤回、
fiber 回卷清空全部 sink、无 sink 静默。
