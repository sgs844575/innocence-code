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
];
const PLUGINS = [
  { dir: "packages/plugin-example", id: "example" },
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

// 自检：staging 内 kernel 库与试点插件的入口产物必须真实存在。
for (const required of [
  join(STAGING, "node_modules", "@innocencecode", "kernel", "dist", "index.js"),
  join(STAGING, "plugins", "example", "dist", "index.js"),
]) {
  if (!existsSync(required)) {
    console.error(`staging self-check failed: missing ${required}`);
    process.exit(1);
  }
}
console.log(`staging assembled at ${STAGING}`);
