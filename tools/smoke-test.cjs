// Smoke test: launch the packaged exe with InnocenceCode_SMOKE_OUT set; the app
// writes the renderer load outcome to that file and exits on its own.
// Falls back to killing the process tree by PID after a timeout.
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const exe = "D:/Projects/AiProjects/InnocenceCode/out/InnocenceCode-win32-x64/InnocenceCode.exe";
const marker = path.join(os.tmpdir(), `innocencecode-smoke-${Date.now()}.txt`);
try { fs.unlinkSync(marker); } catch {}

const child = spawn(exe, [], {
  stdio: "ignore",
  env: { ...process.env, InnocenceCode_SMOKE_OUT: marker },
});
const pid = child.pid;
console.log("spawned pid:", pid, "marker:", marker);

const deadline = Date.now() + 30000;
const poll = setInterval(() => {
  if (fs.existsSync(marker)) {
    clearInterval(poll);
    const result = fs.readFileSync(marker, "utf8");
    console.log("RESULT:", result);
    // Give app.quit() a moment, then clean up if still alive.
    setTimeout(() => kill(), 2000);
  } else if (Date.now() > deadline) {
    clearInterval(poll);
    console.log("TIMEOUT: no load result within 30s");
    kill();
    process.exitCode = 1;
  }
}, 250);

function kill() {
  try {
    // /T kills this process tree only; never taskkill by image name here —
    // other Electron apps on this machine would be hit.
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    console.log("killed pid:", pid);
  } catch {
    console.log("process already exited");
  }
  if (process.exitCode === undefined) {
    process.exit(fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === "ok" ? 0 : 1);
  }
}

child.on("exit", (code) => {
  if (!fs.existsSync(marker)) {
    console.log("exe exited early, code:", code);
    clearInterval(poll);
    process.exit(1);
  }
});
