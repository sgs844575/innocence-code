// Test-facing staging path resolution (Node-level, Electron-free): where the
// dev tree's build:plugins output lives. Shared by the composePlugins and
// pluginBoot integration tests so both skip together on clean checkouts that
// have not run `npm run build:plugins` yet (packaged-exit precedent).
import path from "node:path";

/** Dev staging layout: <repo>/build/dist/resources (mirrors packaged resources/). */
export function stagingBootPaths(): { kernelPath: string; builtinRoot: string } {
  const staging = path.resolve(process.cwd(), "build", "dist", "resources");
  return {
    kernelPath: path.join(staging, "node_modules", "@innocencecode", "kernel", "dist", "index.js"),
    builtinRoot: path.join(staging, "plugins"),
  };
}
