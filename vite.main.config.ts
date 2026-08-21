import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

// Workspace packages are consumed as TypeScript source via aliases — the
// bundle inlines them, so packaging never chases node_modules symlinks.
// Resolved from cwd (forge/vite always run from the project root); do NOT
// use import.meta.url here — vite's config loader remaps it.
const pkg = (name: string) =>
  path.resolve(process.cwd(), "packages", name, "src", "index.ts");

// Bare + node:-prefixed Node builtins. These MUST stay runtime requires: an
// incomplete external list lets rolldown "externalize them for browser
// compatibility" (empty stubs), which crashes the Electron main at load
// (e.g. `(0, _.promisify) is not a function`). electron + electron/* and
// node-pty (native addon, ASAR-unpacked by forge.config.ts) join them.
// (String | RegExp entries only: rolldown's bundler binding rejects plain
// function externals when driven through forge's JS API.)
const externalIds: Array<string | RegExp> = [
  "electron",
  "electron/common",
  "electron/main",
  "node-pty",
  /^node:/,
  ...builtinModules.flatMap((module) => [module, `node:${module}`]),
];

// Bundled to .vite/build/ — referenced by package.json "main".
// Two entries: the app main (main.js) and the packaged-exit smoke entry
// (smoke.js) that npm run package:smoke runs inside the packaged bundle.
export default defineConfig({
  build: {
    lib: {
      entry: { main: "src/main/index.ts", smoke: "src/main/packageSmoke.ts" },
      formats: ["cjs"],
      fileName: () => "[name].js",
    },
    outDir: ".vite/build",
    rollupOptions: {
      external: externalIds,
    },
  },
  resolve: {
    // Keep main-process builds fast; target the bundled Node runtime.
    mainFields: ["module", "main"],
    alias: {
      "@innocencecode/provider-mock": pkg("provider-mock"),
      "@innocencecode/provider-openai": pkg("provider-openai"),
      "@innocencecode/provider-anthropic": pkg("provider-anthropic"),
      "@innocencecode/tools-fs": pkg("tools-fs"),
      "@innocencecode/tools-shell": pkg("tools-shell"),
      "@innocencecode/tools-todo": pkg("tools-todo"),
      "@innocencecode/plugin-subagent": pkg("plugin-subagent"),
      "@innocencecode/plugin-skills": pkg("plugin-skills"),
      "@innocencecode/plugin-mcp": pkg("plugin-mcp"),
      "@innocencecode/plugin-task": pkg("plugin-task"),
      "@innocencecode/harness-electron": pkg("harness-electron"),
      "@innocencecode/terminal-pty": pkg("terminal-pty"),
      // task stack (P1): the command service, its CLI adapter, the Git
      // adapter, the workspace repository, plugin-task's attribution fold and
      // the hardened storage all compile from source into the bundle
      "@innocencecode/task-cli": pkg("task-cli"),
      "@innocencecode/task-core": pkg("task-core"),
      "@innocencecode/task-git": pkg("task-git"),
      "@innocencecode/task-workspace": pkg("task-workspace"),
      "@innocencecode/secure-storage-node": pkg("secure-storage-node"),
    },
  },
});
