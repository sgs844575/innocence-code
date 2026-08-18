// Minimal file-based logger. Writes to userData/logs.
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

let logStream: fs.WriteStream | null = null;

function stream(): fs.WriteStream {
  if (!logStream) {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    logStream = fs.createWriteStream(path.join(dir, `main-${stamp}.log`), { flags: "ax" });
  }
  return logStream;
}

export function log(level: "info" | "warn" | "error", message: string, extra?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${
    extra !== undefined ? ` ${safeStringify(extra)}` : ""
  }\n`;
  stream().write(line);
  if (level === "error") process.stderr.write(line);
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  info: (msg: string, extra?: unknown) => log("info", msg, extra),
  warn: (msg: string, extra?: unknown) => log("warn", msg, extra),
  error: (msg: string, extra?: unknown) => log("error", msg, extra),
};
