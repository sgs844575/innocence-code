import type { ComponentType } from "react";
import type { ToolCallPart, ToolResultPart } from "../../../../../shared/ipc";
import { BashTool } from "./BashTool";
import { EditTool } from "./EditTool";
import { FileTool } from "./FileTool";
import { TaskTool } from "./TaskTool";
import { UnknownTool } from "./UnknownTool";

/** 工具卡统一接口：TurnCollapse 按此契约渲染每个工具行。 */
export interface ToolCardProps {
  call: ToolCallPart;
  result?: ToolResultPart;
  open: boolean;
  onToggle: () => void;
}

const REGISTRY: Record<string, ComponentType<ToolCardProps>> = {
  Bash: BashTool,
  Edit: EditTool,
  Read: FileTool,
  Write: FileTool,
  Glob: FileTool,
  Grep: FileTool,
  Task: TaskTool,
};

export function getToolCard(toolName: string): ComponentType<ToolCardProps> {
  return REGISTRY[toolName] ?? UnknownTool; // mcp__* 与未来工具统一兜底
}
