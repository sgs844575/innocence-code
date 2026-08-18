// Custom `innocencecode://` protocol (`protocol.handle` + a dedicated app
// scheme) so the renderer is served from a stable, secure origin and the CSP
// can lock script-src to 'self'.
import { protocol } from "electron";
import fs from "node:fs";
import path from "node:path";

export const APP_SCHEME = "innocencecode";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export function registerAppScheme(): void {
  // Must be called before app is ready.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

export function handleAppScheme(): void {
  const rendererRoot = path.join(__dirname, "../renderer");
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    // innocencecode://app/<path> -> .vite/renderer/<path>
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const target = rel === "" || rel.endsWith("/") ? path.join(rel, "index.html") : rel;
    const resolved = path.normalize(path.join(rendererRoot, target));
    if (!resolved.startsWith(rendererRoot)) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      // Read through fs, NOT net.fetch(pathToFileURL(...)): fs resolves paths
      // inside app.asar transparently, while the network-service file loader
      // does not (fails with ERR_FILE_NOT_FOUND for asar member paths).
      const body = fs.readFileSync(resolved);
      const type =
        MIME[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
      return new Response(body, { headers: { "content-type": type } });
    } catch (err) {
      return new Response(`Not found: ${request.url} -> ${resolved}\n${String(err)}`, {
        status: 404,
      });
    }
  });
}

export function appIndexUrl(): string {
  return `${APP_SCHEME}://app/index.html`;
}
