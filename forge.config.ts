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
