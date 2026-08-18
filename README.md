# InnocenceCode — AI 编程助手桌面客户端

基于 Electron 构建的 AI 对话客户端，界面包含启动动画、侧边栏会话、流式聊天与跟随系统主题，
全部代码为本项目原创实现。

## 技术栈

| 环节 | 方案 |
|---|---|
| 桌面框架 | Electron 42.3.0 + electron-forge 7.11.2 |
| 构建 | Vite 8.1.5，产物在 `.vite/build` |
| 前端 | React 19 + Tailwind v4（`@layer theme, base, components, utilities`） |
| 进程安全 | `sandbox: true` + `contextIsolation` + contextBridge，共享类型契约 |
| 渲染加载 | 自定义协议（`innocencecode://`）+ `protocol.handle` |
| CSP | index.html meta，`script-src 'self'`，见 `src/webview/index.html` |
| 主题 | nativeTheme → 根类 `electron-dark` / `electron-light`（`src/main/theme.ts` + `src/webview/src/lib/theme.ts`） |
| 原生菜单 | `src/main/locales/` 多语言 JSON（zh-CN / en-US） |
| 启动画面 | index.html 内联启动动画（logo shimmer），React 挂载后替换（`>_` 几何标记 shimmer） |

## 目录结构

```
InnocenceCode/
├── package.json               # main: .vite/build/main.js
├── forge.config.ts            # electron-forge + vite 插件
├── vite.{main,preload,renderer}.config.ts
└── src/
    ├── shared/ipc.ts          # IPC 通道名 + 类型契约（主进程/预加载共用）
    ├── main/                  # 主进程
    │   ├── index.ts           # 入口：单实例锁、生命周期
    │   ├── appWindow.ts       # 窗口创建、ready-to-show、导航拦截
    │   ├── protocol.ts        # innocencecode:// 自定义协议
    │   ├── menu.ts            # 原生菜单 + 多语言
    │   ├── theme.ts           # nativeTheme 主题同步
    │   ├── ipc.ts             # 全部 ipcMain.handle 注册
    │   ├── sessions.ts        # 会话/消息存储（内存版，可换 SQLite）
    │   ├── mockAgent.ts       # 流式 mock 模型（chat:delta → chat:done）
    │   ├── logger.ts          # 文件日志
    │   └── locales/           # 菜单文案 zh-CN / en-US
    ├── preload/index.ts       # contextBridge 暴露 window.innocencecode（最小 API 面）
    └── webview/               # 渲染进程
        ├── index.html         # CSP + 启动动画 + Tailwind layer 顺序声明
        └── src/
            ├── main.tsx       # 动态 import 应用壳
            ├── App.tsx        # 布局 + 会话/流式状态
            ├── components/    # Sidebar / ChatView / MessageItem / Markdown / Composer
            ├── lib/           # ipc 客户端 / 主题 / i18n
            └── styles/app.css # Tailwind v4 + 主题变量（electron-dark/light）
```

## 运行

```bash
npm install
npm start        # 开发模式（vite dev server + electron）
npm run typecheck
npm run package  # 打包验证（产物在 out/）
npm run make     # Windows 安装包（squirrel + zip）
```

## 如何接入真实模型

`src/main/mockAgent.ts` 是唯一的后端假实现。把 `buildReply` / `startStream` 换成真实
的模型 API（或本地模型服务子进程），IPC 契约（`src/shared/ipc.ts`）与全部界面代码
保持不动——后端与 UI 分离，模型侧可以独立替换。

## 当前限制

- 图标使用自绘 `>_` 几何标记；
- 后端为本地 mock 流式模型；
- 会话存内存（可换 SQLite）；无更新器/遥测/崩溃上报（保留接入位）。
