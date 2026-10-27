#!/usr/bin/env node
/**
 * 构建 TieZ 便携版并打包 zip —— 供 `npm run build:portable` 与 CI
 * (.github/workflows/release.yml) 使用。
 *
 * 便携版 = `--features portable`（不写 DPAPI 加密、不建 FTS 索引，搜索走 LIKE），
 * 产物是单文件 exe + `artifacts/portable/tiez-portable.zip`，不含安装包。
 *
 * 注意：便携版与安装版共用 `src-tauri/target/release/tiez-app.exe`，
 * 后构建者覆盖前者 —— 想两个都要，就先构建安装包，再跑本脚本。
 *
 * 用法：
 *   node scripts/build-portable.mjs              # 构建 + 校验 + 打包
 *   node scripts/build-portable.mjs --skip-build # 跳过 tauri build，只校验 + 打包现有 exe
 *   node scripts/build-portable.mjs --no-zip     # 只构建 + 校验（本地换 exe 用得上）
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);

const isWindows = process.platform === "win32";
const exeName = isWindows ? "tiez-app.exe" : "tiez-app";
const packageName = isWindows ? "TieZ.exe" : "TieZ";
const exePath = join(repoRoot, "src-tauri", "target", "release", exeName);
const outDir = join(repoRoot, "artifacts", "portable");
const zipPath = join(outDir, "tiez-portable.zip");

/** 生产构建才会内嵌前端资源；`cargo build --release` 的 dev 包指向 localhost:1420。 */
const FRONTEND_MARKER = "assets/index-";
/** portable feature 会跳过 FTS 索引迁移，因此这句 SQL 不该出现在便携版里。 */
const FTS_MARKER = "CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_fts";

const log = (msg) => console.log(`[build:portable] ${msg}`);
const fail = (msg) => {
  console.error(`[build:portable] ✗ ${msg}`);
  process.exit(1);
};

const run = (command, args) => {
  log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: isWindows,
  });
  if (result.error) fail(`${command} 启动失败：${result.error.message}`);
  if (result.status !== 0) fail(`${command} 退出码 ${result.status}`);
};

if (!hasFlag("--skip-build")) {
  // `tauri build` 会自动跑 beforeBuildCommand = `npm run build`（前端）。
  run("npx", ["tauri", "build", "--features", "portable", "--no-bundle"]);
}

if (!existsSync(exePath)) {
  fail(`找不到产物 ${exePath}，先跑一次 npx tauri build --features portable --no-bundle`);
}

const exeStat = statSync(exePath);
const bytes = readFileSync(exePath).toString("latin1");
const hasFrontend = bytes.includes(FRONTEND_MARKER);
const hasFts = bytes.includes(FTS_MARKER);

log(`exe: ${exePath}`);
log(`     ${(exeStat.size / 1024 / 1024).toFixed(1)} MB, ${exeStat.mtime.toISOString()}`);

if (!hasFrontend) {
  fail(
    "这个 exe 没有内嵌前端（找不到 assets/index-），是 dev 上下文的包。\n" +
      "  必须用 `npx tauri build`，不能用 `cargo build --release`。"
  );
}
if (hasFts) {
  fail(
    "这个 exe 里含有 FTS 建表语句，说明 portable feature 没生效（不是便携版）。\n" +
      "  请用 `npx tauri build --features portable --no-bundle` 重新构建。"
  );
}
log("✓ 校验通过：生产前端已内嵌，且不含 FTS 索引（portable feature 生效）");

if (hasFlag("--no-zip")) {
  log("已跳过打包（--no-zip）");
  process.exit(0);
}

if (!isWindows) {
  log("非 Windows 平台跳过 zip 打包（CI 的 portable 产物只在 Windows 构建）。");
  process.exit(0);
}

const staging = join(outDir, "staging");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
copyFileSync(exePath, join(staging, packageName));

rmSync(zipPath, { force: true });
const compress = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${join(staging, packageName)}' -DestinationPath '${zipPath}' -Force`,
  ],
  { stdio: "inherit" }
);
rmSync(staging, { recursive: true, force: true });

if (compress.status !== 0 || !existsSync(zipPath)) {
  fail("Compress-Archive 打包失败");
}

log(`✓ 便携版: ${zipPath} (${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
