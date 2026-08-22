// 内置工具卡贡献：模块级常量数组（引用稳定，满足槽位注册不抖动契约）
// + 挂载即注册的哑组件；替换原 registry 内的硬编码映射字面量。
import type { ComponentType } from "react";
import { useRegisterKeyed } from "../../../slots/react";
import type { KeyedContribution } from "../../../slots/types";
import { BashTool } from "./BashTool";
import { EditTool } from "./EditTool";
import { FileTool } from "./FileTool";
import { McpToolCard } from "./McpToolCard";
import { TaskTool } from "./TaskTool";
import { TodoWriteCard } from "./TodoWriteCard";
import { TOOLCARD_SLOT, type ToolCardProps } from "./registry";

type CardContribution = KeyedContribution<ComponentType<ToolCardProps>>;

/** 八张内置卡按工具名精确注册；外部服务器工具走 mcp__ 前缀通用卡。 */
export const BUILTIN_TOOLCARD_CONTRIBUTIONS: readonly CardContribution[] = [
  { key: "Bash", value: BashTool },
  { key: "Edit", value: EditTool },
  { key: "Read", value: FileTool },
  { key: "Write", value: FileTool },
  { key: "Glob", value: FileTool },
  { key: "Grep", value: FileTool },
  { key: "Task", value: TaskTool },
  { key: "TodoWrite", value: TodoWriteCard },
  { key: "prefix:mcp__", value: McpToolCard },
];

/** 单条注册哑组件：每条贡献独立持钩，规避数组循环内调用钩子。 */
function Registrar({ contribution }: { contribution: CardContribution }): React.JSX.Element | null {
  useRegisterKeyed(TOOLCARD_SLOT, contribution);
  return null;
}

/** 挂载于 <SlotProvider> 内：把内置卡族注册进工具卡键控槽；卸载时整体注销。 */
export function BuiltinToolcards(): React.JSX.Element {
  return <>{BUILTIN_TOOLCARD_CONTRIBUTIONS.map((c) => <Registrar key={c.key} contribution={c} />)}</>;
}
