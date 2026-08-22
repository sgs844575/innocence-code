// 渲染层 client 模块（零 import 铁律）的 Node 级单测：api 桩捕获注册调用，
// 另以源码扫描钉死"零 import"这一自包含约束（宿主侧按结构化类型装载）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import registerClient, { type ToolCardDescriptor } from "../src/client";

/** api 桩：记录 registerToolCard 调用；前缀注册面不应被示例触碰。 */
function apiStub() {
  const cards: Array<{ toolName: string; descriptor: ToolCardDescriptor }> = [];
  const prefixes: Array<{ prefix: string; descriptor: ToolCardDescriptor }> = [];
  return {
    cards,
    prefixes,
    api: {
      registerToolCard(toolName: string, descriptor: ToolCardDescriptor): void {
        cards.push({ toolName, descriptor });
      },
      registerToolCardPrefix(prefix: string, descriptor: ToolCardDescriptor): void {
        prefixes.push({ prefix, descriptor });
      },
    },
  };
}

describe("example plugin client module", () => {
  it("default 注册函数向 api 注册 example 工具卡描述符", () => {
    const stub = apiStub();
    registerClient(stub.api);
    expect(stub.cards).toEqual([{ toolName: "example", descriptor: { title: "示例插件卡" } }]);
    expect(stub.prefixes).toEqual([]);
  });

  it("零 import（自包含铁律：宿主以动态导入装载，禁止任何依赖说明符）", () => {
    const source = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
    // 只匹配真实导入语法（行首 import 语句 / 动态 import( / require(），
    // 注释里的普通文字不受影响。
    expect(/^\s*import[\s{"'(*]/m.test(source)).toBe(false);
    expect(/\bimport\s*\(/.test(source)).toBe(false);
    expect(/\brequire\s*\(/.test(source)).toBe(false);
  });
});
