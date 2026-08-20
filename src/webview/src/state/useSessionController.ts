// useSessionController — 会话选择/创建/删除（Task 12 从 App.tsx 拆出）。
// 职责：sessions 列表与选中态、落地态的项目选择、近期项目聚合、首条消息
// 时的延迟建会。不渲染任何视图；ChatView/Sidebar 通过 props 消费。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HarnessSettings, Session } from "../../../shared/ipc";
import { api } from "../lib/ipc";

export interface SessionControllerDeps {
  /** 当前设置（工作区跟随所选会话的项目）。 */
  settings: HarnessSettings | null;
  /** 设置补丁回调（App 的 applySettingsPatch）。 */
  onSettingsChange: (patch: Partial<HarnessSettings>) => void;
  /** 错误提示（App 的 showError）。 */
  showError: (message: string) => void;
  /** i18n。 */
  t: (key: string) => string;
}

export interface SessionController {
  sessions: Session[];
  activeId: string | null;
  pendingProject: string;
  recentProjects: { path: string; count: number }[];
  selectSession: (id: string) => void;
  newSession: () => void;
  deleteSession: (id: string) => Promise<void>;
  setPendingProject: (dir: string) => void;
  pickProjectDir: () => Promise<void>;
  /** 首条消息发送前的建会（返回会话 id；失败返回 null）。 */
  ensureSessionForSend: () => Promise<string | null>;
}

export function useSessionController(deps: SessionControllerDeps): SessionController {
  const { settings, onSettingsChange, showError, t } = deps;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // 落地态选中的项目："" = 不在项目中。进入落地态时默认取当前工作区。
  const [pendingProject, setPendingProject] = useState("");

  useEffect(() => {
    void api.listSessions().then(setSessions);
  }, []);

  // The main process pushes the session list after every store mutation, so
  // the sidebar stays in sync no matter which path created/changed a session.
  useEffect(() => {
    const off = api.onSessionsChanged((list) => setSessions(list));
    return off;
  }, []);

  useEffect(() => {
    if (activeId === null) setPendingProject(settings?.workspaceRoot ?? "");
  }, [activeId, settings?.workspaceRoot]);

  // 会话切换携带项目：agent 的工作区（settings.workspaceRoot）跟随所选
  // 会话的绑定项目——侧栏分组与实际执行目录永远一致。
  const selectSession = useCallback(
    (id: string) => {
      setActiveId(id);
      const ws = sessions.find((s) => s.id === id)?.workspaceRoot ?? "";
      if (settings && ws !== settings.workspaceRoot) {
        onSettingsChange({ workspaceRoot: ws });
      }
    },
    [sessions, settings, onSettingsChange],
  );

  // 新建 ≠ 创建：点「新建会话」只回到落地态（输入居中 + 项目选择），侧栏
  // 不出条目；真正的 createSession 在首条消息发送时发生（ensureSessionForSend）。
  const newSession = useCallback(() => {
    setActiveId(null);
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await api.deleteSession(id);
        if (id === activeId) setActiveId(null);
        setSessions((prev) => prev.filter((s) => s.id !== id));
      } catch (err) {
        console.error("delete session failed", err);
        showError(t("error.deleteSession"));
      }
    },
    [activeId, t, showError],
  );

  /** 近期聊天的项目：从会话历史聚合（最近使用优先，最多 5 个）。 */
  const recentProjects = useMemo(() => {
    const byPath = new Map<string, { path: string; count: number; last: number }>();
    for (const s of sessions) {
      const p = s.workspaceRoot ?? "";
      if (!p) continue;
      const cur = byPath.get(p);
      byPath.set(p, { path: p, count: (cur?.count ?? 0) + 1, last: Math.max(cur?.last ?? 0, s.updatedAt) });
    }
    return [...byPath.values()]
      .sort((a, b) => b.last - a.last)
      .slice(0, 5)
      .map(({ path, count }) => ({ path, count }));
  }, [sessions]);

  /** 落地态「打开项目…」：结果只进选择器，不直接改全局（发送时才生效）。 */
  const pickProjectDir = useCallback(async () => {
    const dir = await api.pickWorkspace();
    if (dir) setPendingProject(dir);
  }, []);

  /** 落地态首条消息：此刻才创建会话，绑定所选项目并同步全局工作区
   * （runtime 的 agent 以 settings.workspaceRoot 为根）。 */
  const ensureSessionForSend = useCallback(async (): Promise<string | null> => {
    const ws = pendingProject;
    try {
      if (ws !== (settings?.workspaceRoot ?? "")) {
        onSettingsChange({ workspaceRoot: ws });
      }
      const session = await api.createSession({ workspaceRoot: ws });
      setActiveId(session.id);
      return session.id;
    } catch (err) {
      console.error("create session failed", err);
      showError(t("error.createSession"));
      return null;
    }
  }, [pendingProject, settings?.workspaceRoot, onSettingsChange, showError, t]);

  return {
    sessions,
    activeId,
    pendingProject,
    recentProjects,
    selectSession,
    newSession,
    deleteSession,
    setPendingProject,
    pickProjectDir,
    ensureSessionForSend,
  };
}
