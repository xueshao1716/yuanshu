// ===== autopatch-track.mjs —— 自动补丁的"收尾"（2026-10-27）=====
//
// 之前那条线的终点是「提交到 auto/capability-* 分支，等人合并」——但没人提醒，
// 补丁就会一直躺在那儿（真机里已经躺了一个）。
//
// 这一层负责：
//   ① 给每个补丁分支算状态：待合并 / 已合并 / 已丢弃 / 过期（躺太久）
//   ② 算「够不够格自动合并」：改动小、无保护文件、门禁通过过、不太旧
//   ③ 给一行提醒（进环境事实），并落 `记忆/运行时/自动补丁.json`
//
// 红线不变：**默认不自动合并**。只有配置文件显式打开 `autoMerge` 才合并，
// 且条件全部满足才动手；否则只提醒。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitBin } from "./repo-root.mjs";
import { listPatchBranches, mergeBranch } from "./autopatch-branch.mjs";

export const STATE_FILE = path.join("记忆", "运行时", "自动补丁.json");
export const CONFIG_FILE = path.join("记忆", "运行时", "自动合并.json");
export const DEFAULT_MAX_AGE_DAYS = 7;
export const DEFAULT_MAX_FILES = 3;

const stateFile = (ws) => path.join(String(ws || "."), STATE_FILE);
const configFile = (ws) => path.join(String(ws || "."), CONFIG_FILE);

const git = (repo, args) => execFileSync(gitBin() || "git", ["-c", "core.quotePath=false", "-c", `safe.directory=${String(repo).replace(/\\/g, "/")}`, ...args], {
  cwd: repo, encoding: "utf8", timeout: 30000, windowsHide: true, stdio: "pipe",
});

export function readConfig(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(wsRoot), "utf8"));
    return {
      autoMerge: raw?.autoMerge === true,
      maxAgeDays: Number(raw?.maxAgeDays) > 0 ? Number(raw.maxAgeDays) : DEFAULT_MAX_AGE_DAYS,
      maxFiles: Number(raw?.maxFiles) > 0 ? Number(raw.maxFiles) : DEFAULT_MAX_FILES,
    };
  } catch {
    return { autoMerge: false, maxAgeDays: DEFAULT_MAX_AGE_DAYS, maxFiles: DEFAULT_MAX_FILES };
  }
}

export function readPatchState(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(wsRoot), "utf8"));
    if (raw && typeof raw === "object" && raw.branches) return raw;
  } catch {}
  return { v: 1, updatedAt: 0, branches: {} };
}

function writePatchState(wsRoot, data) {
  const p = stateFile(wsRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...data, v: 1, updatedAt: Date.now() }, null, 2), "utf8");
  return data;
}

/** 分支是否已经并进 main。 */
export function isMerged(repoRoot, branch) {
  try {
    const out = git(repoRoot, ["branch", "--merged", "main", "--format=%(refname:short)"]);
    return out.split(/\r?\n/).map((x) => x.trim()).includes(branch);
  } catch { return false }
}

/** 分支最后一次提交距今多少天。 */
export function ageDaysOf(repoRoot, branch, now = Date.now()) {
  try {
    const ts = Number(git(repoRoot, ["log", "-1", "--format=%ct", branch]).trim()) * 1000;
    if (!ts) return null;
    return Math.max(0, (now - ts) / 86400000);
  } catch { return null }
}

/**
 * 给一个补丁算状态与"够不够格"。
 * @returns {{branch:string, state:string, ready:boolean, reasons:string[], files:number, ageDays:number|null}}
 */
export function describePatch(repoRoot, branch, { config, now = Date.now() } = {}) {
  const cfg = config || { autoMerge: false, maxAgeDays: DEFAULT_MAX_AGE_DAYS, maxFiles: DEFAULT_MAX_FILES };
  const merged = isMerged(repoRoot, branch);
  if (merged) return { branch, state: "merged", ready: false, reasons: ["已合并"], files: 0, ageDays: ageDaysOf(repoRoot, branch, now) };

  let files = 0;
  let names = [];
  try {
    const out = git(repoRoot, ["diff", "--name-only", `main...${branch}`]);
    names = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    files = names.length;
  } catch { files = 0 }

  const ageDays = ageDaysOf(repoRoot, branch, now);
  const reasons = [];
  if (files === 0) reasons.push("没有实际改动");
  if (files > cfg.maxFiles) reasons.push(`改动文件过多（${files} > ${cfg.maxFiles}）`);
  if (ageDays !== null && ageDays > cfg.maxAgeDays) reasons.push(`躺了 ${Math.round(ageDays)} 天（上限 ${cfg.maxAgeDays}）`);
  const protectedHit = names.filter((n) => /(^|\/)(\.token|auth\.json|\.env)$|(^|\/)记忆\//.test(n));
  if (protectedHit.length) reasons.push(`碰到保护文件（${protectedHit.slice(0, 2).join("、")}）`);

  const state = ageDays !== null && ageDays > cfg.maxAgeDays ? "stale" : "awaiting_review";
  return {
    branch, state, ready: reasons.length === 0 && cfg.autoMerge,
    reasons, files, ageDays, names: names.slice(0, 8),
  };
}

/**
 * 同步所有补丁分支的状态。
 * @returns {{awaiting:number, merged:number, stale:number, patches:Array, autoMerged:string[]}}
 */
export function syncPatches({ wsRoot, repoRoot, now = Date.now(), doAutoMerge = true } = {}) {
  const cfg = readConfig(wsRoot);
  let branches = [];
  try { branches = listPatchBranches(repoRoot) } catch { branches = [] }
  const rows = Array.isArray(branches) ? branches : (branches?.items || []);
  const patches = [];
  const autoMerged = [];

  for (const b of rows) {
    const branch = typeof b === "string" ? b : b.branch || b.name;
    if (!branch) continue;
    const d = describePatch(repoRoot, branch, { config: cfg, now });
    // 够格 + 配置允许 → 自动合并（默认配置下 ready 恒为 false）
    if (doAutoMerge && d.ready) {
      try {
        const m = mergeBranch(repoRoot, branch);
        if (m?.ok !== false) {
          autoMerged.push(branch);
          patches.push({ ...d, state: "merged", mergedAt: now, auto: true });
          continue;
        }
        d.reasons = [...d.reasons, `自动合并失败：${String(m?.error || "").slice(0, 60)}`];
      } catch (e) {
        d.reasons = [...d.reasons, `自动合并异常：${String(e?.message || e).slice(0, 60)}`];
      }
    }
    patches.push(d);
  }

  const state = readPatchState(wsRoot);
  const branchesMap = {};
  for (const p of patches) {
    const prev = state.branches[p.branch] || {};
    branchesMap[p.branch] = {
      state: p.state,
      ready: !!p.ready,
      reasons: p.reasons || [],
      files: p.files || 0,
      ageDays: p.ageDays ?? null,
      names: p.names || [],
      firstSeenAt: prev.firstSeenAt || now,
      lastSeenAt: now,
    };
  }
  writePatchState(wsRoot, { ...state, config: cfg, branches: branchesMap });

  return {
    awaiting: patches.filter((p) => p.state === "awaiting_review").length,
    merged: patches.filter((p) => p.state === "merged").length,
    stale: patches.filter((p) => p.state === "stale").length,
    patches,
    autoMerged,
  };
}

/** 环境事实一行。 */
export function patchLine(wsRoot, { maxItems = 3 } = {}) {
  const state = readPatchState(wsRoot);
  const rows = Object.entries(state.branches || {})
    .filter(([, v]) => v.state === "awaiting_review" || v.state === "stale")
    .sort((a, b) => (b[1].ageDays || 0) - (a[1].ageDays || 0));
  if (!rows.length) return "";
  const head = rows.slice(0, maxItems).map(([branch, v]) => {
    const tag = v.state === "stale" ? "过期" : "待合并";
    return `${branch}（${tag}${v.files ? `，${v.files} 个文件` : ""}）`;
  });
  return `【自动补丁】${rows.length} 个等你处理：${head.join("；")}——在「自动补丁」页看改动再合并，或直接丢弃。`;
}
