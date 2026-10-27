// ===== claim-board.mjs —— 认领板（2026-10-27）=====
//
// 抄 Agensh 的第一块砖：**谁在做什么，得写在黑板上**。
// Agensh 让每个 agent 自主「读全局 → 认领子任务 → 声明范围 → 避免撞车 → 验证后合并」；
// 元枢原来只有分支和门禁，没有"认领"这一层——多个 subagent 同时跑就会踩脚。
//
// 规则（刻意保守，宁可让人多问一句）：
//   · 同一 task 只能有一个 active 认领；
//   · scope 是文件路径/目录，**和别人的 scope 重叠就算冲突**；
//   · 认领有 TTL（默认 30 分钟），过期自动变 expired，可被重新认领；
//   · 释放要做完才 done，否则记 abandoned（可追溯）。
import fs from "node:fs";
import path from "node:path";

export const BOARD_REL = path.join("记忆", "运行时", "认领板.json");
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const MAX_CLAIMS = 200;

const fileOf = (ws) => path.join(String(ws || "."), BOARD_REL);

export function readBoard(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsRoot), "utf8"));
    if (raw && Array.isArray(raw.claims)) return raw;
  } catch {}
  return { v: 1, claims: [] };
}

function writeBoard(wsRoot, data) {
  fs.mkdirSync(path.dirname(fileOf(wsRoot)), { recursive: true });
  fs.writeFileSync(fileOf(wsRoot), JSON.stringify({ ...data, v: 1, updatedAt: Date.now() }, null, 2), "utf8");
}

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();

/** 两个 scope 是否重叠（相同、包含、或互为前缀目录）。 */
export function scopesOverlap(a = [], b = []) {
  for (const x of a) {
    for (const y of b) {
      const p = norm(x), q = norm(y);
      if (!p || !q) continue;
      if (p === q) return true;
      if (p.startsWith(q + "/") || q.startsWith(p + "/")) return true;
      // 2026-10-27：一边是绝对路径（D:/pi-web/engine/a.mjs）、一边是仓库相对路径时，
      // 前缀比较没用——按"尾部"对才算得对。
      if (p.endsWith("/" + q) || q.endsWith("/" + p)) return true;
    }
  }
  return false;
}

export function activeClaims(wsRoot, { now = Date.now() } = {}) {
  const board = readBoard(wsRoot);
  return (board.claims || [])
    .filter((c) => c.state === "active")
    .map((c) => ({ ...c, expired: Number(c.expiresAt) > 0 && Number(c.expiresAt) <= now }));
}

/**
 * 认领一件事。
 * @returns {{ok:boolean, claim?:object, error?:string, conflicts?:Array}}
 */
export function claimTask({ wsRoot, task, agent = "xiaoyu", scope = [], branch = "", ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const name = String(task || "").trim().slice(0, 120);
  const who = String(agent || "xiaoyu").trim().slice(0, 60);
  if (!name) return { ok: false, error: "task 不能为空" };
  const sc = (Array.isArray(scope) ? scope : [scope]).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 20);

  const board = readBoard(wsRoot);
  const active = (board.claims || []).filter((c) => c.state === "active" && Number(c.expiresAt) > now);

  const sameTask = active.find((c) => norm(c.task) === norm(name));
  if (sameTask) {
    if (sameTask.agent === who) return { ok: true, claim: sameTask, already: true };
    return { ok: false, error: `「${name}」已被 ${sameTask.agent} 认领`, conflicts: [sameTask] };
  }

  const conflicts = sc.length ? active.filter((c) => scopesOverlap(c.scope || [], sc)) : [];
  if (conflicts.length) {
    return { ok: false, error: `范围和 ${conflicts.map((c) => c.agent).join("、")} 重叠`, conflicts };
  }

  const claim = {
    id: `c-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    task: name, agent: who, scope: sc, branch: String(branch || "").slice(0, 120),
    state: "active", createdAt: now, expiresAt: ttlMs > 0 ? now + ttlMs : 0,
  };
  board.claims = [claim, ...(board.claims || [])].slice(0, MAX_CLAIMS);
  writeBoard(wsRoot, board);
  return { ok: true, claim };
}

/** 续期。 */
export function renewClaim({ wsRoot, id, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const board = readBoard(wsRoot);
  const c = (board.claims || []).find((x) => x.id === id);
  if (!c) return { ok: false, error: "没有这条认领" };
  if (c.state !== "active") return { ok: false, error: `状态是 ${c.state}，不能续期` };
  c.expiresAt = ttlMs > 0 ? now + ttlMs : 0;
  c.renewedAt = now;
  writeBoard(wsRoot, board);
  return { ok: true, claim: c };
}

/** 释放（done=完成，否则算放弃）。 */
export function releaseClaim({ wsRoot, id, done = false, note = "", now = Date.now() } = {}) {
  const board = readBoard(wsRoot);
  const c = (board.claims || []).find((x) => x.id === id);
  if (!c) return { ok: false, error: "没有这条认领" };
  c.state = done ? "done" : "abandoned";
  c.closedAt = now;
  if (note) c.note = String(note).slice(0, 200);
  writeBoard(wsRoot, board);
  return { ok: true, claim: c };
}

/** 把过期的标成 expired（扫描时调用）。 */
export function reapExpired({ wsRoot, now = Date.now() } = {}) {
  const board = readBoard(wsRoot);
  let reaped = 0;
  for (const c of board.claims || []) {
    if (c.state === "active" && Number(c.expiresAt) > 0 && Number(c.expiresAt) <= now) {
      c.state = "expired";
      c.closedAt = now;
      reaped += 1;
    }
  }
  if (reaped) writeBoard(wsRoot, board);
  return { reaped };
}

export function listClaims(wsRoot, { limit = 30, includeClosed = false } = {}) {
  const board = readBoard(wsRoot);
  const rows = (board.claims || []).filter((c) => includeClosed || c.state === "active");
  return rows.slice(0, Math.max(1, limit));
}

/** 给环境事实/面板用：正在做的事一句话。 */
export function claimsLine(wsRoot, { now = Date.now() } = {}) {
  const active = activeClaims(wsRoot, { now }).filter((c) => !c.expired);
  if (!active.length) return "";
  const head = active.slice(0, 3).map((c) => `${c.agent}：${c.task}`).join("；");
  return `【认领】${active.length} 件在做：${head}`;
}
