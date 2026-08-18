// Ambient globals injected by @electron-forge/plugin-vite's `define` config
// at build time (see node_modules/@electron-forge/plugin-vite/dist/config/
// vite.base.config.js getBuildDefine). The renderer target is named
// "main_window" in forge.config.ts, so the key is MAIN_WINDOW_* — these are
// NOT process.env vars, they are statically replaced identifiers.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
