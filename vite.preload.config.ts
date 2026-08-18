import { defineConfig } from "vite";

// Sandbox preloads must stay CommonJS (no ESM imports in the sandboxed world).
export default defineConfig({
  build: {
    lib: {
      entry: "src/preload/index.ts",
      formats: ["cjs"],
      fileName: () => "preload.js",
    },
    outDir: ".vite/build",
    rollupOptions: {
      external: ["electron"],
    },
  },
});
