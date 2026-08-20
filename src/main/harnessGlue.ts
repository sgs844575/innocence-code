// Harness glue — owns settings persistence, the HarnessRuntime instance and
// the permission-ask bridge between the runtime and the renderer. This module
// is the host composition root: it declaratively assembles each agent
// session's plugin set from PLUGIN_DESCRIPTORS (fs/shell core tools,
// subagents, project skills, MCP servers, session todo tool) — the active set
// comes from resolvePluginSet over project .innocence/plugins.yml + user
// settings toggles.
import { app, dialog, type BrowserWindow } from "electron";
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
import {
  loadInnocenceConfig,
  loadPluginToggles,
  resolvePluginSet,
  rulesFromConfig,
  type HarnessPlugin,
  type PluginDescriptor,
  type PluginToggleSource,
  type ProjectPermissionConfig,
} from "@innocencecode/harness-core";
import { fsPlugin } from "@innocencecode/tools-fs";
import { shellPlugin } from "@innocencecode/tools-shell";
import { subagentPlugin } from "@innocencecode/plugin-subagent";
import { skillsPlugin } from "@innocencecode/plugin-skills";
import { mcpPlugin } from "@innocencecode/plugin-mcp";
import { todoPlugin } from "@innocencecode/tools-todo";
import {
  IPC,
  appendText,
  type ChatPermissionEvent,
  type ChatToolEvent,
  type PermissionChoice,
} from "../shared/ipc";
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

const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

let settings: PkgSettings = DEFAULT_SETTINGS;
const pendingAsks = new Map<string, (choice: PermissionChoice) => void>();

function settingsFile(): string {
  return path.join(app.getPath("userData"), "harness-settings.json");
}

function transcriptsDir(): string {
  return path.join(app.getPath("userData"), "transcripts");
}

function send(channel: string, payload: unknown): void {
  const win: BrowserWindow | undefined = getMainWindow() ?? undefined;
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Project permission rules (.innocence/config.json) as a plugin, so the
 *  runtime never loads project config itself — the composition root owns it. */
function projectRulesPlugin(config: ProjectPermissionConfig | undefined): HarnessPlugin {
  return {
    name: "project-permission-rules",
    activate(ctx) {
      if (!config) return;
      for (const rule of rulesFromConfig(config)) ctx.registerPolicyRule(rule);
    },
  };
}

/** 声明式插件关系表（spec B 3.4）：id → 依赖，core = 恒开不可关。
 *  组合根只声明关系与实例化，启停判定（两级覆盖/依赖连带）全部交给
 *  resolvePluginSet。描述符 id "todo" 映射 todoPlugin 实例（插件 name
 *  为 "todoPlugin"，与描述符 id 不同名，故在此注明对应关系）。 */
export const PLUGIN_DESCRIPTORS: readonly PluginDescriptor[] = [
  { id: "fs", dependencies: [], core: true },
  { id: "shell", dependencies: [], core: true },
  { id: "subagent", dependencies: ["fs", "shell"] },
  { id: "skills", dependencies: ["fs"] },
  { id: "mcp", dependencies: [] },
  { id: "todo", dependencies: [] },
];

/** Host composition root: one workspace's plugin set — workspace tools,
 *  subagents, project permission rules, project skills, MCP servers and the
 *  session todo tool. Declarative assembly: project plugins.yml + user
 *  toggles → resolvePluginSet → instantiate by active id. fs/shell are core
 *  and the project-rules plugin is not toggleable, so all three are always
 *  present; skipped plugins and resolver warnings surface through the logger.
 *  Exported for the integration test (real yml + real resolver, no Electron). */
export async function composePlugins(
  workspaceRoot: string,
  userToggles?: PluginToggleSource,
): Promise<HarnessPlugin[]> {
  const [config, project] = await Promise.all([
    loadInnocenceConfig(workspaceRoot),
    loadPluginToggles(workspaceRoot, {
      // yml 损坏/未知键告警必须进 userData/logs，而非 core 的 console 兜底。
      logger: (level, msg, data) => logger[level === "error" ? "error" : "warn"](msg, data),
    }),
  ]);
  const resolved = resolvePluginSet(PLUGIN_DESCRIPTORS, userToggles, project);
  for (const { id, reason, via } of resolved.skipped) {
    logger.info("plugin skipped", { id, reason, via });
  }
  for (const warning of resolved.warnings) logger.warn("plugin set", warning);

  const active = new Set(resolved.active);
  const plugins: HarnessPlugin[] = [];
  if (active.has("fs")) plugins.push(fsPlugin);
  if (active.has("shell")) plugins.push(shellPlugin);
  // 项目权限规则在关系模型之外（spec 非目标：不可关闭），恒定注入。
  plugins.push(projectRulesPlugin(config.permissions));
  if (active.has("subagent")) plugins.push(subagentPlugin);
  if (active.has("skills")) {
    plugins.push(skillsPlugin({ dirs: [path.join(workspaceRoot, ".innocence", "skills")] }));
  }
  if (active.has("mcp")) plugins.push(mcpPlugin({ servers: config.mcpServers ?? {} }));
  if (active.has("todo")) plugins.push(todoPlugin);
  return plugins;
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
    ...(await composePlugins(context.workspaceRoot, settings.pluginToggles)),
    // Route-scoped task sessions get the change-capture middleware bound to
    // the live task's port; plain chat contexts contribute nothing.
    ...taskPluginsForRoute(taskBridge, context),
  ],
  hooks: {
    onDelta: (sessionId, messageId, delta) => {
      sessions.updateMessage(sessionId, messageId, (m) => {
        m.parts = appendText(m.parts, delta);
      });
      send(IPC.chatDelta, { sessionId, messageId, delta });
    },
    // Structured tool events: persist the part on the assistant message and
    // broadcast it so the renderer mirrors the live stream part-by-part.
    onTool: (sessionId, messageId, part) => {
      // LiveToolPart carries harness-core's optional isError; the shared
      // contract requires it, so normalize at this boundary.
      const normalized: ChatToolEvent["part"] =
        part.type === "toolCall"
          ? part
          : {
              type: "toolResult",
              toolCallId: part.toolCallId,
              content: part.content,
              isError: part.isError === true,
              durationMs: part.durationMs,
            };
      sessions.updateMessage(sessionId, messageId, (m) => {
        m.parts.push(normalized);
      });
      send(IPC.chatTool, { sessionId, messageId, part: normalized });
    },
    onThinking: (sessionId, messageId, delta) => {
      sessions.updateMessage(sessionId, messageId, (m) => {
        const last = m.parts[m.parts.length - 1];
        if (last?.type === "thinking") last.text += delta;
        else m.parts.push({ type: "thinking", text: delta });
      });
      send(IPC.chatThinking, { sessionId, messageId, delta });
    },
    onCompleted: (sessionId, messageId) => {
      sessions.updateMessage(sessionId, messageId, { streaming: false });
      send(IPC.chatDone, { sessionId, messageId });
    },
    onError: (sessionId, messageId, error) => {
      sessions.updateMessage(sessionId, messageId, { streaming: false });
      send(IPC.chatError, { sessionId, messageId, error });
      logger.warn("harness error", { sessionId, messageId, error });
    },
    askPermission: async (sessionId, messageId, ask) => {
      const event: ChatPermissionEvent = {
        sessionId,
        messageId,
        requestId: ask.requestId,
        toolName: ask.call.toolName,
        args: ask.call.args,
        // 脱敏持久化资源摘要（kind/action/scope）——raw 值在 core 侧已
        // 被 persistArgs/permissionResource 挡在门外，这里只透传镜像。
        resource: {
          kind: ask.call.resource.kind,
          action: ask.call.resource.action,
          scope: ask.call.resource.scope,
        },
      };
      return new Promise<PermissionChoice>((resolve) => {
        let settled = false;
        const finish = (choice: PermissionChoice) => {
          if (settled) return;
          settled = true;
          pendingAsks.delete(ask.requestId);
          clearTimeout(timer);
          resolve(choice);
        };
        // Unanswered asks default to deny — never block the loop forever.
        const timer = setTimeout(() => finish("deny"), PERMISSION_TIMEOUT_MS);
        pendingAsks.set(ask.requestId, finish);
        send(IPC.chatPermission, event);
      });
    },
    log: (level, msg, data) => {
      // Route by severity — a runtime dispose failure arrives as "error"
      // and must reach logger.error, not sink into the info stream.
      const entry = { msg, data: String(data) };
      if (level === "error") logger.error("harness", entry);
      else if (level === "warn") logger.warn("harness", entry);
      else logger.info("harness", entry);
    },
  },
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

/** Starts an agent turn; returns the assistant message id immediately. Plain
 *  chat turns run on the main route without task identity. */
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
  void runtime.send({ sessionId, taskId: "", routeId: DEFAULT_ROUTE_ID, text, messageId: id });
  return id;
}

export function stopChatTurn(sessionId: string): void {
  runtime.stop(sessionId);
}

/** Releases one chat session's agent resources (aborts runs, disposes its
 *  plugins). Never rejects — failures surface through the harness log. */
export async function disposeSession(sessionId: string): Promise<void> {
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
