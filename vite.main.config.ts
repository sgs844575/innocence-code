import { builtinModules } from "node:module";
import { defineConfig } from "vite";

// Workspace packages resolve through node_modules (npm workspaces symlinks
// pointing at each package's src entry) exactly like any other dependency —
// there are NO workspace aliases anymore: the kernel and the registration
// spine are loaded dynamically from the staging/resources tree (see
// src/main/pluginBoot), so the bundle never chases them at build time.

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
  },
});
