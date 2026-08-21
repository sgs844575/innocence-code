// Harness glue — owns settings persistence, the HarnessRuntime instance and
// the permission-ask bridge between the runtime and the renderer. This module
// is the host composition root: it resolves each agent session's plugin set
// through the kernel-backed plugin boot (pluginBoot.ts — the staging kernel,
// the dual-root resolver and the builtin manifest live there), so the active
// set comes from staging manifest.json descriptors + resolvePluginSet (local
// copy) over project .innocence/plugins.yml + user settings toggles.
import { app, dialog, type BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ROUTE_ID,
  HarnessRuntime,
  DEFAULT_SETTINGS,
  listModels,
  mergeSettings,
  resolveActive,
  MOCK_GREETING,
  type HarnessSettings as PkgSettings,
} from "@innocencecode/harness-electron";
import {
  loadInnocenceConfig,
  rulesFromConfig,
  type HarnessPlugin,
  type InnocenceConfig,
  type ProjectPermissionConfig,
  type Provider,
  type SessionPlugin,
} from "@innocencecode/harness-core";
import { createProviderPlugin } from "@innocencecode/harness-providers";
import { createOpenAIProvider } from "@innocencecode/provider-openai";
import { createAnthropicProvider } from "@innocencecode/provider-anthropic";
import { createMockProvider } from "@innocencecode/provider-mock";
import {
  IPC,
  appendText,
  type ChatPermissionEvent,
  type ChatToolEvent,
  type PermissionChoice,
} from "../shared/ipc";
import type { PluginBoot } from "./pluginBoot";
import { createPluginBoot } from "./pluginBoot";
import type { PluginToggleSource } from "./plugin-toggles-local";
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

/**
 * Provider instance from the active settings profile (migrated here from
 * harness-electron/provider-builder.ts — the composition layer owns provider
 * assembly now; the runtime no longer builds providers).
 */
function buildProviderFromSettings(settings: PkgSettings): Provider {
  const active = resolveActive(settings);
  // 空串 = 跟随模型默认（不传参）；off 交给 provider 层解释（openai 省略、anthropic 不开启）。
  const reasoningEffort = settings.reasoningEffort || undefined;
  switch (active.kind) {
    case "openai":
      return createOpenAIProvider({
        apiKey: active.apiKey || undefined,
        baseURL: active.baseURL || undefined,
        model: active.model,
        reasoningEffort,
      });
    case "anthropic":
      return createAnthropicProvider({
        apiKey: active.apiKey || undefined,
        model: active.model,
        reasoningEffort,
      });
    default:
      return createMockProvider({ id: "mock", turns: [], exhaustedText: MOCK_GREETING });
  }
}

// ---------------------------------------------------------------------------
// Plugin boot（内核化装载）
// ---------------------------------------------------------------------------

/** dev：仓库 staging 树；prod：打包 resources 下的同一布局（forge
 *  extraResource 把 build/dist/resources/{plugins,node_modules} 复制到
 *  resources/）。内核经动态 import 装载（单实例），src/main 不再静态
 *  import vendor/kernel 的运行时值。 */
function bootPaths(): { kernelPath: string; builtinRoot: string } {
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

/** Lazy boot singleton：首个会话组装触发创建（staging 缺失时错误在会话
 *  构建路径显性抛出，不影响应用启动）；settings/workspaceRoot 不在此固
 *  化——每会话经 resolveBuiltinSet 现取（settings 重建语义零变化）。 */
let bootPromise: Promise<PluginBoot> | undefined;

function ensureBoot(): Promise<PluginBoot> {
  bootPromise ??= createPluginBoot({
    ...bootPaths(),
    workspaceRoot: settings.workspaceRoot || undefined,
  });
  return bootPromise;
}

/** App shutdown: unwinds the boot root (cascades into live route scopes).
 *  Never rejects — failures surface through the harness log. */
export async function disposePluginBoot(): Promise<void> {
  const pending = bootPromise;
  bootPromise = undefined;
  const boot = await pending?.catch(() => undefined);
  if (!boot) return;
  try {
    await boot.dispose();
  } catch (err) {
    logger.warn("plugin boot dispose failed", { error: String(err) });
  }
}

/** 磁盘装载一个内置能力插件并按 id 装配：fs/shell/todo/subagent 为插件
 *  对象（default 导出）；skills/mcp 为工厂（default 导出），由组合根注入
 *  配置后实例化。name 与清单 id 同名（composePlugins.test 的 1:1 守卫）。 */
async function builtinPluginFor(
  boot: PluginBoot,
  id: string,
  config: InnocenceConfig,
  workspaceRoot: string,
): Promise<SessionPlugin> {
  const value = await boot.importPlugin(id);
  switch (id) {
    case "fs":
    case "shell":
    case "todo":
    case "subagent":
      return value as SessionPlugin;
    case "skills":
      return (value as (options: { dirs: string[] }) => SessionPlugin)({
        dirs: [path.join(workspaceRoot, ".innocence", "skills")],
      });
    case "mcp":
      return (value as (options: { servers: Record<string, unknown> }) => SessionPlugin)({
        servers: (config.mcpServers ?? {}) as Record<string, unknown>,
      });
    default:
      throw new Error(`builtin plugin "${id}" has no composition branch`);
  }
}

/** Host composition root: one workspace's plugin set — workspace tools,
 *  subagents, project permission rules, project skills, MCP servers, the
 *  session todo tool and the settings-based provider. Declarative assembly:
 *  staging manifest descriptors + project plugins.yml + user toggles →
 *  resolvePluginSet（本地拷贝）→ 按清单 id 从 staging 双根磁盘装载
 *  （boot 的 FileModuleResolver；用户根在前）。Instantiation order matches
 *  the pre-T11 static composition exactly; the provider is assembled per
 *  session and wrapped as a kernel provider plugin (name "provider") so the
 *  session resolves it through the providers registry; the project-rules
 *  plugin remains a legacy plugin the session kernel adapts. fs/shell are
 *  core and the project-rules/provider plugins are not toggleable, so all of
 *  them are always present; skipped plugins and resolver warnings surface
 *  through the logger. Exported for the integration test (real yml + real
 *  resolver + real staging tree, no Electron). */
export async function composePlugins(
  workspaceRoot: string,
  userToggles?: PluginToggleSource,
  settings: PkgSettings = DEFAULT_SETTINGS,
): Promise<SessionPlugin[]> {
  const boot = await ensureBoot();
  const [config, resolved] = await Promise.all([
    loadInnocenceConfig(workspaceRoot),
    boot.resolveBuiltinSet({
      workspaceRoot,
      userToggles,
      // yml 损坏/未知键告警必须进 userData/logs，而非 console 兜底。
      logger: (level, msg, data) => logger[level === "error" ? "error" : "warn"](msg, data),
    }),
  ]);
  for (const { id, reason, via } of resolved.skipped) {
    logger.info("plugin skipped", { id, reason, via });
  }
  for (const warning of resolved.warnings) logger.warn("plugin set", warning);

  const active = new Set(resolved.active);
  const plugins: SessionPlugin[] = [];
  if (active.has("fs")) plugins.push(await builtinPluginFor(boot, "fs", config, workspaceRoot));
  if (active.has("shell")) plugins.push(await builtinPluginFor(boot, "shell", config, workspaceRoot));
  // 项目权限规则在关系模型之外（spec 非目标：不可关闭），恒定注入。
  plugins.push(projectRulesPlugin(config.permissions));
  if (active.has("subagent")) {
    plugins.push(await builtinPluginFor(boot, "subagent", config, workspaceRoot));
  }
  if (active.has("skills")) {
    plugins.push(await builtinPluginFor(boot, "skills", config, workspaceRoot));
  }
  if (active.has("mcp")) plugins.push(await builtinPluginFor(boot, "mcp", config, workspaceRoot));
  if (active.has("todo")) plugins.push(await builtinPluginFor(boot, "todo", config, workspaceRoot));
  // Provider assembly per session (the build-time settings): one provider
  // plugin named "provider" — the session kernel resolves the registry's
  // sole registered provider, so this is the only provider path.
  plugins.push(createProviderPlugin(buildProviderFromSettings(settings)));
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
  // Route scopes: every session build mounts into a fresh kernel scope below
  // the plugin-boot root (dynamic staging kernel) — session dispose unwinds
  // the whole scope; the root and sibling routes stay untouched.
  sessionScope: async () => (await ensureBoot()).createSessionScope(),
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
    ...(await composePlugins(context.workspaceRoot, settings.pluginToggles, settings)),
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
 * plugins). Never rejects — failures surface through the harness log. */
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
