import type { ComponentType } from "react";
import type { ToolCallPart, ToolResultPart } from "../../../../../shared/ipc";
import { useSlotKeyedResolve } from "../../../slots/react";
import { UnknownTool } from "./UnknownTool";

/** 工具卡统一接口：TurnCollapse 按此契约渲染每个工具行。 */
export interface ToolCardProps {
  call: ToolCallPart;
  result?: ToolResultPart;
  open: boolean;
  onToggle: () => void;
}

/** 工具卡键控槽标识：key=工具名精确注册，或 "prefix:mcp__" 之类前缀声明。 */
export const TOOLCARD_SLOT = "toolcards";

/**
 * 按工具名解析卡组件：键控槽 resolve（精确名 → 最长前缀）→ 未命中回落兜底卡。
 * 渲染期钩子（订阅槽位变更触发重渲染）——每工具行经 ToolCardRow 各调一次，
 * 不可在循环/条件中直接调用。
 */
export function getToolCard(toolName: string): ComponentType<ToolCardProps> {
  const card = useSlotKeyedResolve<ComponentType<ToolCardProps>>(TOOLCARD_SLOT, toolName);
  return card ?? UnknownTool; // 未注册工具统一兜底
}

/** 单个工具行适配：把解析钩子收进独立行组件，槽位注册变化时按名精准重渲染。 */
export function ToolCardRow(props: ToolCardProps): React.JSX.Element {
  const Card = getToolCard(props.call.toolName);
  return <Card {...props} />;
}
