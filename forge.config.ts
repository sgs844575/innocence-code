import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      // node-pty ships native .node binaries required at runtime — keep the
      // whole package (JS loader + prebuilds) outside the ASAR archive so
      // require("node-pty") works from the bundled main process.
      unpack: "**/node_modules/node-pty/**",
    },
    executableName: "InnocenceCode",
    // Prebuilt kernel libraries and plugins live outside the ASAR archive:
    // plugins are loaded at runtime via dynamic import from resources/, so
    // they must stay as real files on disk (spec D10). @electron/packager
    // 18.4 accepts string entries only and copies each to
    // resources/<basename(entry)>, so listing the two staging children maps
    // directly to resources/plugins and resources/node_modules.
    extraResource: ["build/dist/resources/plugins", "build/dist/resources/node_modules"],
    // The pruner walks the ROOT production graph, which does not include
    // workspace packages' dependencies — node-pty (a dependency of the
    // @innocencecode/terminal-pty workspace) would be pruned away. The ignore
    // filter below is the single source of truth for what ships; pruning is
    // therefore off.
    prune: false,
    // plugin-vite's default copy filter keeps ONLY /.vite — node-pty (the one
    // runtime require vite.main.config.ts externalizes) would never reach the
    // package and require("node-pty") would fail in the packaged app. A
    // function-valued ignore takes over from the plugin: keep the .vite
    // bundles, package.json and node-pty (JS + native prebuilds, unpacked
    // above); every other project file is already inlined into the bundles.
    ignore: (file) => {
      if (!file) return false; // the root path arrives empty — always keep it
      return (
        !file.startsWith("/.vite") &&
        file !== "/package.json" &&
        file !== "/node_modules" &&
        !file.startsWith("/node_modules/node-pty")
      );
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ name: "InnocenceCode", setupExe: "InnocenceCodeSetup.exe" }),
    new MakerZIP({}, ["win32"]),
  ],
  plugins: [
    new VitePlugin({
      // Bundles land in .vite/build/ (package.json "main": .vite/build/main.js).
      build: [
        { entry: "src/main/index.ts", config: "vite.main.config.ts" },
        { entry: "src/preload/index.ts", config: "vite.preload.config.ts" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};

export default config;
