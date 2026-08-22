// 渲染层 client 注册模块（示例插件）：零 import 铁律——宿主经
// innocence-plugin://example/dist/client.js 动态 import 后调用 default，
// 以纯数据描述符注册工具卡；宿主侧统一渲染（组件级注册延后阶段 2）。
// 类型形状内联声明（结构化类型，勿 import 宿主渲染层类型）。

/** 工具卡描述符（与宿主侧描述符契约结构一致：纯数据）。 */
export interface ToolCardDescriptor {
  title?: string;
  renderArgs?: boolean;
  renderResult?: boolean;
}

/** 宿主注入的注册面（与渲染层 PluginClientApi v1 结构一致）。 */
export interface PluginClientApi {
  registerToolCard(toolName: string, descriptor: ToolCardDescriptor): void;
  registerToolCardPrefix(prefix: string, descriptor: ToolCardDescriptor): void;
}

/** 注册入口：为 example 工具注册一张带标题徽标的示例卡。 */
export default function register(api: PluginClientApi): void {
  api.registerToolCard("example", { title: "示例插件卡" });
}
