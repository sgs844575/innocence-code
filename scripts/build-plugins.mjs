// 预构建参与分发的包并组装 staging 树：
//   build/dist/resources/node_modules/@innocencecode/<name>/{dist/,package.json}
//   build/dist/resources/plugins/<id>/{dist/,package.json}
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const LIBS = [
  "vendor/kernel",
  "vendor/kernel-loader",
  "vendor/kernel-include",
  "vendor/kernel-logger",
  // 脊柱八包：能力插件 dist 的跨包裸导入（如 mcp→harness-tools、
  // provider-*→harness-providers、agent-loop→session/tools/permissions/agent）
  // 经 staging node_modules 解析。
  "packages/harness-tools",
  "packages/harness-permissions",
  "packages/harness-providers",
  "packages/harness-skills",
  "packages/harness-session",
  "packages/harness-system-prompt",
  "packages/harness-agent",
  "packages/harness-agent-loop",
];
// 内置清单（boot 侧 toggle 解析的描述符来源）：id + core 标记 + 依赖关系，
// 随 staging 产出 manifest.json。可开关的能力插件——provider/task 等由宿主
// 组合层按需装配，不进 toggle 面；example 为渲染层示例插件（client-only：
// 无会话实例化分支，client 标记驱动 webview 侧装载链）。
const BUILTIN_DESCRIPTORS = [
  { id: "fs", core: true, dependencies: [] },
  { id: "shell", core: true, dependencies: [] },
  { id: "subagent", dependencies: ["fs", "shell"] },
  { id: "skills", dependencies: ["fs"] },
  { id: "mcp", dependencies: [] },
  { id: "todo", dependencies: [] },
  { id: "example", dependencies: [] },
];
const PLUGINS = [
  { dir: "packages/plugin-example", id: "example" },
  { dir: "packages/tools-fs", id: "fs" },
  { dir: "packages/tools-shell", id: "shell" },
  { dir: "packages/tools-todo", id: "todo" },
  { dir: "packages/plugin-skills", id: "skills" },
  { dir: "packages/plugin-mcp", id: "mcp" },
  { dir: "packages/plugin-subagent", id: "subagent" },
  { dir: "packages/plugin-task", id: "task" },
  { dir: "packages/provider-anthropic", id: "provider-anthropic" },
  { dir: "packages/provider-openai", id: "provider-openai" },
  { dir: "packages/provider-mock", id: "provider-mock" },
];
const STAGING = "build/dist/resources";

// 运行时 manifest：源 manifest 的 main/exports 指向 src（开发态源码直引），
// staging 副本改指 dist 产物。
function runtimeManifest(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  return {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    type: pkg.type,
    main: "./dist/index.js",
    exports: { ".": "./dist/index.js", "./package.json": "./package.json" },
  };
}

// tsc 不会重写导入说明符：源码按 bundler 解析写无后缀相对导入（"./context"），
// 而 Node ESM 要求相对说明符带显式扩展名。emit 后就地补 .js，staging 产物才能
// 被 Node（以及打包应用内的动态 import）直接加载。已带扩展名的说明符不动。
function fixEsmSpecifiers(file) {
  let code = readFileSync(file, "utf8");
  code = code.replace(
    /(from\s*|import\s*\(\s*)(["'])(\.\.?\/[^"']*)\2/g,
    (match, keyword, quote, specifier) =>
      /\.(js|mjs|cjs|json)$/.test(specifier) ? match : `${keyword}${quote}${specifier}.js${quote}`,
  );
  writeFileSync(file, code, "utf8");
}

function fixDist(pkgDir) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) { walk(file); continue; }
      if (name.endsWith(".js")) fixEsmSpecifiers(file);
    }
  };
  walk(join(pkgDir, "dist"));
}

function build(pkgDir) {
  rmSync(join(pkgDir, "dist"), { recursive: true, force: true });
  // Windows 上 npx 是 .cmd，spawnSync 必须经 shell 才能找到（参数为固定字面量）。
  const tsc = spawnSync("npx", ["tsc", "-p", join(pkgDir, "tsconfig.build.json")], { stdio: "inherit", shell: true });
  if (tsc.status !== 0) { console.error(`build failed: ${pkgDir}`); process.exit(1); }
  fixDist(pkgDir);
}

rmSync("build/dist", { recursive: true, force: true });
for (const dir of LIBS) {
  build(dir);
  const pkg = runtimeManifest(dir);
  const name = pkg.name.replace(/^@innocencecode\//, "");
  const target = join(STAGING, "node_modules", "@innocencecode", name);
  mkdirSync(target, { recursive: true });
  cpSync(join(dir, "dist"), join(target, "dist"), { recursive: true });
  writeFileSync(join(target, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
}
for (const { dir, id } of PLUGINS) {
  build(dir);
  const pkg = runtimeManifest(dir);
  const target = join(STAGING, "plugins", id);
  mkdirSync(target, { recursive: true });
  cpSync(join(dir, "dist"), join(target, "dist"), { recursive: true });
  writeFileSync(join(target, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

// 内置清单：boot 读取的插件 id 列表 + core 标记 + 依赖 + 中性展示名（包
// description 投影为 title）+ client 标记（构建后 dist/client.js 是否存在）。
const builtinIds = new Set(PLUGINS.map(({ id }) => id));
for (const descriptor of BUILTIN_DESCRIPTORS) {
  if (!builtinIds.has(descriptor.id)) {
    console.error(`builtin descriptor "${descriptor.id}" has no staged plugin`);
    process.exit(1);
  }
}
const manifestPlugins = BUILTIN_DESCRIPTORS.map((descriptor) => {
  const stagedPkg = JSON.parse(readFileSync(join(STAGING, "plugins", descriptor.id, "package.json"), "utf8"));
  return {
    ...descriptor,
    title: typeof stagedPkg.description === "string" && stagedPkg.description !== ""
      ? stagedPkg.description
      : descriptor.id,
    client: existsSync(join(STAGING, "plugins", descriptor.id, "dist", "client.js")),
  };
});
writeFileSync(
  join(STAGING, "plugins", "manifest.json"),
  JSON.stringify({ plugins: manifestPlugins }, null, 2) + "\n",
  "utf8",
);

// 自检：staging 内 kernel 库与各清单插件的入口产物必须真实存在。
const selfCheck = [join(STAGING, "node_modules", "@innocencecode", "kernel", "dist", "index.js")];
for (const dir of LIBS) {
  if (dir.startsWith("packages/")) {
    selfCheck.push(join(STAGING, "node_modules", "@innocencecode", dir.slice("packages/".length), "dist", "index.js"));
  }
}
selfCheck.push(join(STAGING, "plugins", "manifest.json"));
for (const { id } of PLUGINS) selfCheck.push(join(STAGING, "plugins", id, "dist", "index.js"));
for (const required of selfCheck) {
  if (!existsSync(required)) {
    console.error(`staging self-check failed: missing ${required}`);
    process.exit(1);
  }
}
// 自检（manifest 扩展）：每条清单条目带非空 title 与布尔 client，且
// client:true 的渲染层产物真实存在（plugins:list 投影的数据源契约）。
const manifest = JSON.parse(readFileSync(join(STAGING, "plugins", "manifest.json"), "utf8"));
for (const entry of manifest.plugins) {
  if (typeof entry.title !== "string" || entry.title === "") {
    console.error(`staging self-check failed: manifest entry "${entry.id}" lacks a title`);
    process.exit(1);
  }
  if (typeof entry.client !== "boolean") {
    console.error(`staging self-check failed: manifest entry "${entry.id}" lacks a client flag`);
    process.exit(1);
  }
  if (entry.client && !existsSync(join(STAGING, "plugins", entry.id, "dist", "client.js"))) {
    console.error(`staging self-check failed: manifest entry "${entry.id}" marks client without dist/client.js`);
    process.exit(1);
  }
}
console.log(`staging assembled at ${STAGING}`);
