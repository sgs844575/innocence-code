import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Renderer sources live under src/webview.
  root: "src/webview",
  plugins: [
    react(),
    tailwindcss(),
    {
      // The strict CSP meta tag only applies to production builds. In dev,
      // vite/react-refresh injects inline scripts that would be blocked.
      name: "dev-csp-strip",
      apply: "serve" as const,
      transformIndexHtml(html: string): string {
        return html.replace(
          /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/,
          "",
        );
      },
    },
  ],
  build: {
    outDir: "../../.vite/renderer",
    emptyOutDir: true,
  },
});
