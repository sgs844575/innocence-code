# kernel-include — YAML 条目清单 include 内建

`@innocencecode/kernel-include` 提供加载器内建 `Include`：把一份 YAML 顶层数组格式的条目清单挂载为子树。

## 作用

- `Include` 注册在加载器内建表（通常放在 `kernel:include` 名下）。
- 配置形如 `{ path }`：`path` 相对 `ctx.baseUrl`（缺省为 cwd）解析。
- 清单顶层数组的每一行成为 include 条目之下的 loader entry：id 带前缀组合，并随 include fiber 一起回卷。
- 读取、解析或挂载失败会令 include fiber 失败并经加载器上浮。

## 使用

```ts
import { Context } from "@innocencecode/kernel";
import { Loader } from "@innocencecode/kernel-loader";
import { Include } from "@innocencecode/kernel-include";

const ctx = new Context();
await ctx.plugin(Loader);
ctx.loader.builtins.include = Include;
await ctx.loader.create({ name: "kernel:include", config: { path: "./entries.yml" } });
await ctx.loader.await();
```

## 测试

无独立测试文件；由 `vendor/kernel-loader` 的组合测试（`loader-composition.spec.ts`）覆盖。
