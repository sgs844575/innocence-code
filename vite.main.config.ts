import path from "node:path";
import { defineConfig } from "vite";

// Workspace packages are consumed as TypeScript source via aliases — the
// bundle inlines them, so packaging never chases node_modules symlinks.
// Resolved from cwd (forge/vite always run from the project root); do NOT
// use import.meta.url here — vite's config loader remaps it.
const pkg = (name: string) =>
  path.resolve(process.cwd(), "packages", name, "src", "index.ts");

// Bundled to .vite/build/main.js — referenced by package.json "main".
export default defineConfig({
  build: {
    lib: {
      entry: "src/main/index.ts",
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    outDir: ".vite/build",
    rollupOptions: {
      external: ["electron"],
    },
  },
  resolve: {
    // Keep main-process builds fast; target the bundled Node runtime.
    mainFields: ["module", "main"],
    alias: {
      "@innocencecode/harness-core": pkg("harness-core"),
      "@innocencecode/provider-mock": pkg("provider-mock"),
      "@innocencecode/provider-openai": pkg("provider-openai"),
      "@innocencecode/provider-anthropic": pkg("provider-anthropic"),
      "@innocencecode/tools-fs": pkg("tools-fs"),
      "@innocencecode/tools-shell": pkg("tools-shell"),
      "@innocencecode/plugin-subagent": pkg("plugin-subagent"),
      "@innocencecode/plugin-skills": pkg("plugin-skills"),
      "@innocencecode/harness-electron": pkg("harness-electron"),
    },
  },
});
