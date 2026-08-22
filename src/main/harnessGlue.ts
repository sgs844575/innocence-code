// Harness glue — owns settings persistence, the HarnessRuntime instance and
// the permission-ask registry. This module is the host composition root: it
// resolves each agent session's plugin set, kernel scope and spine suite
// through the session composition (pluginBoot/sessionComposition.ts — the
// staging kernel/spine boot, the dual-root resolver, builtin plugin loading
// and per-session assembly live there), so the active set comes from staging
// manifest.json descriptors + resolvePluginSet (local copy) over project
// .innocence/plugins.yml + user settings toggles. The runtime's UI-bridge
// hooks live in runtimeHooks.ts.
import { app, dialog } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ROUTE_ID,
  HarnessRuntime,
  DEFAULT_SETTINGS,
  listModels,
  mergeSettings,
  type HarnessSettings as PkgSettings,
} from "@innocencecode/harness-electron";
import type { PermissionChoice, PluginInventory } from "../shared/ipc";
import type { PluginBoot } from "./pluginBoot";
import { createSessionComposition } from "./pluginBoot";
import { createRuntimeHooks } from "./runtimeHooks";
import * as sessions from "./sessions";
import { getMainWindow } from "./appWindow";
import { broadcastTheme, setTheme } from "./theme";
import { logger } from "./logger";
import { broadcastSessions } from "./sessionEvents";
import {
  createTaskRuntimeBridge,
  resolveTaskWorkspaceRoot,
  taskPluginsForRoute,
  type TaskRuntimeBridge,
} from "./taskRuntimeBridge";

let settings: PkgSettings = DEFAULT_SETTINGS;
const pendingAsks = new Map<string, (choice: PermissionChoice) => void>();

function settingsFile(): string {
  return path.join(app.getPath("userData"), "harness-settings.json");
}

function transcriptsDir(): string {
  return path.join(app.getPath("userData"), "transcripts");
}

// ---------------------------------------------------------------------------
// Plugin boot（内核化装载）
// ---------------------------------------------------------------------------

/** dev：仓库 staging 树；prod：打包 resources 下的同一布局（forge
 *  extraResource 把 build/dist/resources/{plugins,node_modules} 复制到
 *  resources/）。内核与脊柱经动态 import 装载（单实例），src/main 不再静态
 *  import vendor/kernel 的运行时值。插件协议接线（innocence-plugin:// 的
 *  内置根）复用同一双分支，消除打包态 cwd 相对路径的 404。 */
export function bootPaths(): { kernelPath: string; builtinRoot: string } {
  if (app.isPackaged) {
    const resources = process.resourcesPath;
    return {
      kernelPath: path.join(resources, "node_modules", "@innocencecode", "kernel", "dist", "index.js"),
      builtinRoot: path.join(resources, "plugins"),
    };
  }
  const staging = path.resolve(process.cwd(), "build", "dist", "resources");
  return {
    kernelPath: path.join(staging, "node_modules", "@innocencecode", "kernel", "dist", "index.js"),
    builtinRoot: path.join(staging, "plugins"),
  };
}

/** Session composition: the boot singleton (retry-on-failure), builtin
 *  plugin loading and per-session plugin assembly live in pluginBoot/
 *  sessionComposition (Electron-free, Node-testable); this module injects
 *  the Electron-side path/workspace/log ports. */
const sessionComposition = createSessionComposition({
  resolvePaths: bootPaths,
  getWorkspaceRoot: () => settings.workspaceRoot || undefined,
  log: (level, msg, data) => logger[level](msg, data),
});

function ensureBoot(): Promise<PluginBoot> {
  return sessionComposition.ensureBoot();
}

/** App shutdown: unwinds the boot root (cascades into live route scopes).
 *  Never rejects — failures surface through the harness log. */
export async function disposePluginBoot(): Promise<void> {
  await sessionComposition.disposePluginBoot();
}

/** Task runtime bridge: opens tasks (baseline/isolated), holds each task's
 *  TaskRuntimePort and injects plugin-task middleware into route-scoped
 *  sessions (see taskRuntimeBridge.ts — electron-free by construction). */
const taskStorageDir = path.join(app.getPath("userData"), "tasks");
const taskBridge = createTaskRuntimeBridge({
  taskStorageDir,
  log: (level, msg, data) => logger[level]("task bridge", { msg, data: String(data) }),
});

/** Bridge + storage dir for the host's task-runtime IPC composition (Task 12). */
export function getTaskBridge(): TaskRuntimeBridge {
  return taskBridge;
}

export function getTaskStorageDir(): string {
  return taskStorageDir;
}

const runtime = new HarnessRuntime({
  settings: () => settings,
  persistDir: transcriptsDir(),
  // Route scopes: every session build mounts into a fresh kernel scope below
  // the plugin-boot root (dynamic staging kernel) — session dispose unwinds
  // the whole scope; the root and sibling routes stay untouched.
  sessionScope: async () => (await ensureBoot()).createSessionScope(),
  // Route spines: every session build mounts the SAME spine suite the boot
  // loaded from the staging tree (dynamic module identities shared with the
  // disk-loaded capability plugins; one spine per process).
  sessionSpine: async () => (await ensureBoot()).spine,
  // Authoritative per-route workspace root: a live task's effective workspace
  // (the isolated worktree) wins, then the session-bound project root, then
  // settings — settings.workspaceRoot is never the sole task root.
  workspaceRootFor: (context) =>
    (context.taskId ? taskBridge.getRoute(context.taskId, context.routeId)?.workspaceRoot : undefined) ||
    resolveTaskWorkspaceRoot(context.sessionId, {
      getSessionWorkspaceRoot: (id) => sessions.getSession(id)?.workspaceRoot || undefined,
      fallbackRoot: settings.workspaceRoot,
    }),
  forkRoute: (input) => taskBridge.forkRoute(input),
  pluginsForSession: async (context) => [
    ...(await sessionComposition.composePlugins(
      context.workspaceRoot,
      settings.pluginToggles,
      settings,
    )),
    // Route-scoped task sessions get the change-capture middleware bound to
    // the live task's port; plain chat contexts contribute nothing.
    ...taskPluginsForRoute(taskBridge, context),
  ],
  hooks: createRuntimeHooks(pendingAsks),
});

/** Loads persisted settings; call once at app start (idempotent). Runs
 *  before the window exists, so applying the theme needs no broadcast —
 *  the renderer pulls the resolved theme on load. */
export async function initHarness(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), "utf8"));
    settings = mergeSettings(raw);
  } catch {
    settings = DEFAULT_SETTINGS;
  }
  setTheme(settings.themeMode ?? "system");
  logger.info("harness initialized", { activeProfile: settings.activeProfileId });
}

export function getHarnessSettings(): PkgSettings {
  return settings;
}

/** 插件清单投影（IPC plugins:list）：按当前 settings 现算——工作区取
 *  settings（空 = 无项目层），用户开关取 pluginToggles；每次调用重跑
 *  解析，设置写入后的重拉立即反映新状态。 */
export function getPluginInventory(): Promise<PluginInventory> {
  return sessionComposition.pluginInventory({
    workspaceRoot: settings.workspaceRoot || undefined,
    userToggles: settings.pluginToggles,
  });
}

export async function setHarnessSettings(next: PkgSettings): Promise<void> {
  const prevTheme = settings.themeMode ?? "system";
  settings = mergeSettings(next);
  // Theme lives in the settings file now — apply + broadcast when it changes
  // so the appearance page is the single control surface.
  const nextTheme = settings.themeMode ?? "system";
  if (nextTheme !== prevTheme) {
    setTheme(nextTheme);
    const win = getMainWindow();
    if (win && !win.isDestroyed()) broadcastTheme(win);
  }
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
}

/** Fetches a platform's model list (runs in main, where network is available). */
export async function listProviderModels(
  profile: Pick<PkgSettings["profiles"][number], "kind" | "apiKey" | "baseURL">,
): Promise<string[]> {
  return listModels(profile);
}

export async function pickWorkspace(): Promise<string> {
  const win = getMainWindow();
  if (!win) return "";
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || result.filePaths.length === 0 ? "" : result.filePaths[0];
}

export function respondPermission(requestId: string, choice: PermissionChoice): void {
  pendingAsks.get(requestId)?.(choice);
}

let nextMsg = 0;
const messageId = () => `msg_${Date.now().toString(36)}_${(nextMsg++).toString(36)}`;

/**
 * Session -> task-route binding (task:start / switchRoute / restart recovery
 * keep it current): a bound session's chat sends run task-scoped, so tool
 * effects are captured, checkpointed and reviewable — the P1 loop.
 */
const sessionTaskRoutes = new Map<string, { taskId: string; routeId: string }>();

/** Host-side binding port the task command service calls on task activation. */
export function bindSessionTaskRoute(sessionId: string, taskId: string, routeId: string): void {
  sessionTaskRoutes.set(sessionId, { taskId, routeId });
}

/** Starts an agent turn; returns the assistant message id immediately. Plain
 * chat turns run on the main route without task identity; a session with a
 * live task binding sends on the task's active route. */
export function sendChatTurn(sessionId: string, text: string): string {
  const id = messageId();
  sessions.appendMessage(sessionId, {
    id,
    role: "assistant",
    parts: [],
    createdAt: Date.now(),
    streaming: true,
  });
  broadcastSessions();
  const binding = sessionTaskRoutes.get(sessionId);
  void runtime.send({
    sessionId,
    taskId: binding?.taskId ?? "",
    routeId: binding?.routeId ?? DEFAULT_ROUTE_ID,
    text,
    messageId: id,
  });
  return id;
}

export function stopChatTurn(sessionId: string): void {
  runtime.stop(sessionId);
}

/** Releases one chat session's agent resources (aborts runs, disposes its
 *  plugins). Never rejects — failures surface through the harness log. */
export async function disposeSession(sessionId: string): Promise<void> {
  sessionTaskRoutes.delete(sessionId);
  await runtime.dispose(sessionId);
}

/** Rejects every unanswered permission ask (app shutdown): pending turns
 *  must not block on dialogs that will never be answered. */
export function rejectPendingPermissionAsks(): void {
  for (const finish of pendingAsks.values()) finish("deny");
  pendingAsks.clear();
}

/** Releases every agent session's resources (app shutdown): aborts active
 *  runs, disposes all plugins (MCP child trees included). Never rejects. */
export async function disposeAllRuntime(): Promise<void> {
  await runtime.disposeAll();
}

/** Releases every live task's runtime resources (app shutdown): watchers and
 *  worktree lease records. Worktrees survive restarts; explicit task
 *  deletion (destroyWorktree) runs only through the task flows. */
export async function disposeTaskRuntime(): Promise<void> {
  await taskBridge.disposeAll();
}

/** Route-bound terminals (Task 9): the authoritative per-route workspace
 *  root for live tasks. The terminal IPC resolves cwd exclusively through
 *  this — renderer requests carry ids only, never paths. */
export function resolveRouteWorkspaceRoot(taskId: string, routeId: string): string | undefined {
  return taskBridge.getRoute(taskId, routeId)?.workspaceRoot;
}
