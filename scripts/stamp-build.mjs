#!/usr/bin/env node
// 给安装目录"盖章"：写 .yuanshu-build.json（commit + builtAt + version）。
//
// 为什么需要它：安装版没有 .git，`checkUpdate()` 只能用这个标记当"本地版本"。
// 而这个标记以前**只在应用内更新成功后**才刷新；只要用 robocopy / 手工部署，
// 它就永远停在装机那天 → 设置页和弹窗一直报「发现新版本」（2026-10-25 真机：stamp 是 10-24 的 49f2c41，
// 远端早就 20b6715 了，点「立即更新」其实是在原地重启）。
//
// 所以：**每次部署后都跑一遍**。用法：
//   node scripts/stamp-build.mjs                     # 用默认安装目录 + 当前 git HEAD
//   node scripts/stamp-build.mjs --dir "D:\app"      # 指定目录
//   node scripts/stamp-build.mjs --commit abc1234    # 指定提交（CI 里用）
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const argOf = (name, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const repoDir = argOf("repo", "D:\\pi-web");
const installDir = argOf("dir", "C:\\Users\\xuexiaofeng\\AppData\\Local\\Programs\\Yuanshu\\app");

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  } catch { return ""; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

const commit = argOf("commit", gitHead());
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`✗ 拿不到完整提交号（拿到的是 "${commit}"）——不要在未提交状态下盖章，会盖成错的版本`);
  process.exit(1);
}

const version = readJson(path.join(repoDir, "version.json"))?.version || null;
const stampFile = path.join(installDir, ".yuanshu-build.json");
const before = readJson(stampFile);

const stamp = {
  builtAt: new Date().toISOString(),
  commit,
  ...(version ? { version } : {}),
};
fs.mkdirSync(installDir, { recursive: true });
fs.writeFileSync(stampFile, JSON.stringify(stamp, null, 2), "utf8");

console.log(`✓ 已盖章 ${stampFile}`);
console.log(`  commit: ${before?.commit ? before.commit.slice(0, 7) + " → " : ""}${commit.slice(0, 7)}`);
console.log(`  builtAt: ${stamp.builtAt}${version ? `  version: ${version}` : ""}`);
