// 侧边栏会话分组：按 workspaceRoot 聚合（空 = 「不在项目中」兜底组，恒排最后），
// 组间按组内最新会话时间倒序，组内按 updatedAt 倒序。色点由路径哈希决定（稳定）。
import type { Session } from "../../../../shared/ipc";

export interface SessionGroup {
  /** 分组键：workspaceRoot（空串 = 不在项目中）。 */
  key: string;
  /** 显示名：项目目录 basename；空键显示兜底文案（由调用方 i18n 传入）。 */
  name: string;
  sessions: Session[];
}

const DOT_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

export function projectName(workspaceRoot: string): string {
  const name = workspaceRoot.replace(/\\/g, "/").split("/").filter(Boolean).at(-1);
  return name ?? workspaceRoot;
}

/** 路径 → 稳定色点颜色（同一项目恒同色）。 */
export function projectColor(workspaceRoot: string): string {
  let hash = 0;
  const s = workspaceRoot.replace(/\\/g, "/").toLowerCase();
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return DOT_COLORS[Math.abs(hash) % DOT_COLORS.length]!;
}

export function groupSessions(sessions: Session[], noneLabel: string): SessionGroup[] {
  const byKey = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.workspaceRoot ?? "";
    const list = byKey.get(key) ?? [];
    list.push(s);
    byKey.set(key, list);
  }
  const groups: SessionGroup[] = [];
  for (const [key, list] of byKey) {
    if (key === "") continue;
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    groups.push({ key, name: projectName(key), sessions: list });
  }
  groups.sort((a, b) => b.sessions[0]!.updatedAt - a.sessions[0]!.updatedAt);
  const none = byKey.get("");
  if (none && none.length > 0) {
    none.sort((a, b) => b.updatedAt - a.updatedAt);
    groups.push({ key: "", name: noneLabel, sessions: none });
  }
  return groups;
}
