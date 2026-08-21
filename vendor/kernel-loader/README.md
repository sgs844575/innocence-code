# kernel-loader — 配置树加载器（LoaderService / LoaderTree / Loader）

`@innocencecode/kernel-loader` 在内核（`@innocencecode/kernel`）之上提供配置树加载能力：
`Loader` 插件把一个 `LoaderService` 发布为全树可见的 `ctx.loader` 服务，按配置行导入并挂载插件。

## 作用

- **LoaderService**：持有根 `LoaderTree`，解析内建（`kernel:` 前缀）与模块说明符，挂载配置的插件为树上的 fiber；
  `await()` 反复扫树直到没有新 fiber 出现（配置载体或运行中插件新挂的条目也会被等到）。
- **LoaderTree / LoaderEntry**：可变条目树；子树挂在条目上（`owner`），行 id 组合带前缀，并随 owner 的 fiber 一起回卷。
- **Loader**：内核插件，`apply` 时 `ctx.provide("loader", new LoaderService(ctx))`，卸载时撤回。
- **ModuleResolver**：`loader.internal` 注入的模块解析器；裸说明符条目需要它，未配置时导入报错而非静默跳过。
- 本包通过声明合并给 `Context` 增加 `loader` 与 `entry` 类型成员（运行时仅在 Loader 插件加载期间存在）。

## 使用

```ts
import { Context } from "@innocencecode/kernel";
import { Loader } from "@innocencecode/kernel-loader";

const ctx = new Context();
await ctx.plugin(Loader);
const entry = await ctx.loader.create({ id: "probe", name: "kernel:some-builtin", config: { tag: 1 } });
await ctx.loader.await();
```

## 测试

```bash
npx vitest run vendor/kernel-loader
```

覆盖：加载器组合（`loader-composition.spec.ts`，与 `@innocencecode/kernel-include` 联合）。
