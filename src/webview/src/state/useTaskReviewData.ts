// useTaskReviewData — 审查面数据源（最终审查 C3）。task:changes（状态化
// hunks + 变更文件）与 code:list-files（文件树）按 taskId/routeId 拉取；
// 纯加载器与钩子分离（loadTaskReviewData 可脱 React 测试）。刷新入口
// 供 accept/restore 之后由 App 调用对账。
import { useCallback, useEffect, useState } from "react";
import type { CodeIpcApi } from "../../../shared/codeIpc";
import type { TaskChangesResponse, TaskHunkDto, TaskIpcApi } from "../../../shared/taskIpc";
import { codeApi, taskApi } from "../lib/ipc";

export interface TaskReviewData {
  /** task:changes 的状态化 hunks（ReviewPanel / 变更卡数据源）。 */
  hunks: TaskHunkDto[];
  /** 变更文件路径（含无 hunk 的二进制/文件级补丁）。 */
  changedFiles: string[];
  /** code:list-files 的文件树输入（main 侧 500 条上限）。 */
  files: string[];
}

export const emptyTaskReviewData: TaskReviewData = { hunks: [], changedFiles: [], files: [] };

/** 纯加载器：注入的 api + 请求 → 视图数据（无 React 依赖，可单测）。 */
export async function loadTaskReviewData(
  apis: {
    task: Pick<TaskIpcApi, "changes">;
    code: Pick<CodeIpcApi, "listFiles">;
  },
  request: { taskId: string; routeId: string },
): Promise<TaskReviewData> {
  const [changes, listing]: [TaskChangesResponse, { files: string[] }] = await Promise.all([
    apis.task.changes(request),
    apis.code.listFiles(request).catch(() => ({ files: [] as string[] })),
  ]);
  return { hunks: changes.hunks, changedFiles: changes.changedFiles, files: listing.files };
}

export interface TaskReviewDataController extends TaskReviewData {
  /** 重新拉取（accept/restore 后对账；任务上下文为空时无操作）。 */
  refresh: () => Promise<void>;
}

export function useTaskReviewData(deps: {
  taskId: string;
  routeId: string;
}): TaskReviewDataController {
  const { taskId, routeId } = deps;
  const [data, setData] = useState<TaskReviewData>(emptyTaskReviewData);

  const refresh = useCallback(async () => {
    if (taskId === "" || routeId === "") {
      setData(emptyTaskReviewData);
      return;
    }
    try {
      setData(await loadTaskReviewData({ task: taskApi, code: codeApi }, { taskId, routeId }));
    } catch (cause) {
      console.error("task review data load failed", cause);
      setData(emptyTaskReviewData);
    }
  }, [taskId, routeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...data, refresh };
}
