import type { Context } from "@innocencecode/kernel";

// 插件为自己发布的事件登记类型：Events 目录经声明合并扩展，emit/on 才能收窄。
// 消费方可再次合并同一事件（签名一致即合法），见 tests/example.spec.ts。
declare module "@innocencecode/kernel" {
  interface Events {
    "example/ready"(payload: { greeting: string }): void;
  }
}

export interface ExamplePluginConfig { greeting?: string }

/** 试点插件：activate 时发一次 example/ready 事件；作为分发模板使用。 */
export const ExamplePlugin = {
  name: "example",
  apply(ctx: Context) {
    ctx.effect(() => () => {}, "example");
    ctx.emit("example/ready", { greeting: "installed" });
  },
};
export default ExamplePlugin;
