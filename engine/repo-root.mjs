// 自动补丁必须在**源码仓**里跑，而不是安装目录（2026-10-26）
//
// 真机根因：服务从安装目录启动（__dirname = C:\...\Programs\Yuanshu\app），
// 而 repoRoot 直接用了 __dirname → 门禁在安装包里跑测试。
// 安装包没有 frontend/src/ 与 .git，于是：
//   · 4 个读前端源码的测试必然 ENOENT（被误判成"补丁引入的新红灯"）
//   · 就算通过也无法建分支/提交
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** 候选源码仓：显式 env → 常见位置 → 启动目录。 */
export function candidateRepos({ env = process.env, dirname } = {}) {
  const out = [];
  if (env.YUANSHU_REPO_ROOT) out.push(env.YUANSHU_REPO_ROOT);
  out.push("D:/pi-web", "D:\\pi-web");
  const up = dirname ? path.resolve(dirname, "..", "..") : null;
  if (up) out.push(up);
  if (dirname) out.push(dirname);
  return [...new Set(out.filter(Boolean))];
}

/**
 * 找到可用的 git 可执行文件。
 * 2026-10-26 真机：服务进程的 PATH 里没有 git，spawn("git") 直接失败，
 * 于是"源码仓存在却判不出来"，自动补丁全线停摆（日志里 tried 三个路径全被否定）。
 */
export function gitBin() {
  const cands = [
    process.env.YUANSHU_GIT,
    "git",
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
  ].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    if (r.status === 0 || /git version/i.test(String(r.stdout || ""))) return c;
  }
  return null;
}

function isGitRepo(dir) {
  // ① 有 git：问它
  const bin = gitBin();
  if (bin) {
    try {
      const r = spawnSync(bin, ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8", timeout: 15000, windowsHide: true });
      if (r.status === 0 && String(r.stdout).trim() === "true") return true;
    } catch {}
  }
  // ② 没 git（或问不出来）：看有没有 .git —— 有就认为它是仓库，
  //    真正要建分支/提交时再用 gitBin() 报清楚"缺少 git"
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * 解析源码仓根。判据：是 git 工作树 且 有 tests/unit（否则门禁没意义）。
 * @returns {{root:string|null, tried:string[], reason?:string}}
 */
export function resolveRepoRoot({ env = process.env, dirname } = {}) {
  const tried = [];
  for (const dir of candidateRepos({ env, dirname })) {
    tried.push(dir);
    if (!fs.existsSync(dir)) continue;
    if (!isGitRepo(dir)) continue;
    if (!fs.existsSync(path.join(dir, "tests", "unit"))) continue;
    return { root: path.resolve(dir), tried };
  }
  return { root: null, tried, reason: "找不到既是 git 仓库、又有 tests/unit 的源码目录（用 YUANSHU_REPO_ROOT 指定）" };
}
