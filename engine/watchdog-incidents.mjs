// ===== watchdog-incidents.mjs —— 看门狗「跑偏事件」台账（2026-11-07）=====
//
// 背景：detectDrift 的判定以前只追加进 记忆/运行时/看门狗.jsonl，没有 id；
// 推送只有一句「bash 连续失败 3 次」，用户追问「哪个任务」时没有可对号的东西，
// 接口也只能返回"最近 20 条判定"。
//
// 这里把每次 drift=true 落成一条带 id 的事件（drift-<本地时间戳>-<随机>）：
//   · 存在 记忆/运行时/看门狗事件.json，只留最近 50 条；
//   · 带 issues（已含 run/session/时间/samples/evidence）、stats、rows 摘要；
//   · 供 GET /api/watchdog/drift/latest、/api/watchdog/drift/<id> 和 watchdog_read 工具读。
// 写盘失败不影响看门狗本身（调用方拿不到 id 时退回 /latest）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteJson } from "./atomic-io.mjs";

export const INCIDENT_REL = path.join("记忆", "运行时", "看门狗事件.json");
export const MAX_INCIDENTS = 50;

const text = (v) => (v == null ? "" : String(v).trim());

function clip(raw, max) {
  const chars = [...String(raw ?? "").replace(/\s+/g, " ").trim()];
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

export function incidentsFile(wsRoot) {
  return path.join(String(wsRoot || "."), INCIDENT_REL);
}

/** 本地时间戳（人看得懂 22:43，而不是 UTC）：20261107T224354。 */
function stampOf(ms) {
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function newIncidentId(now = Date.now()) {
  return `drift-${stampOf(now)}-${crypto.randomBytes(3).toString("hex")}`;
}

function readItems(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(incidentsFile(wsRoot), "utf8"));
    return Array.isArray(raw?.items) ? raw.items.filter((x) => x && typeof x.id === "string") : [];
  } catch { return [] }
}

/** rows 摘要：只留能定位问题的信息，避免把 300 行审计原样塞进事件文件。 */
function summarizeRows(rows, stats = {}) {
  const safe = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const toolCount = new Map();
  const runIds = [];
  const sessionIds = [];
  let firstAt = null;
  let lastAt = null;
  for (const r of safe) {
    const tool = text(r?.tool);
    if (tool) toolCount.set(tool, (toolCount.get(tool) || 0) + 1);
    const at = Number(r?.at ?? r?.ts);
    if (Number.isFinite(at) && at > 0) {
      firstAt = firstAt == null ? at : Math.min(firstAt, at);
      lastAt = lastAt == null ? at : Math.max(lastAt, at);
    }
    const runId = text(r?.runId ?? r?.run_id);
    if (runId && !runIds.includes(runId) && runIds.length < 5) runIds.push(runId);
    const sessionId = text(r?.sessionId ?? r?.session_id ?? r?.session);
    if (sessionId && !sessionIds.includes(sessionId) && sessionIds.length < 5) sessionIds.push(sessionId);
  }
  const tools = Object.fromEntries([...toolCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6));
  const recent = safe.slice(-5).map((r) => ({
    at: Number(r?.at ?? r?.ts) || null,
    tool: text(r?.tool),
    ok: r?.ok === false ? false : undefined,
    runId: text(r?.runId ?? r?.run_id),
    preview: clip(text(r?.error) || text(r?.resultPreview), 80),
  }));
  return {
    count: safe.length,
    calls: Number(stats?.calls) || safe.length,
    windowMin: Number.isFinite(Number(stats?.windowMin)) ? Number(stats.windowMin) : null,
    tools,
    runIds,
    sessionIds,
    firstAt,
    lastAt,
    recent,
  };
}

/**
 * 落一条 drift 事件。只记 drift=true；没有偏离返回 {ok:false, skipped:true}。
 * @returns {{ok:boolean, incident?:object, skipped?:boolean, error?:string}}
 */
export function recordDriftIncident(wsRoot, result, { now = Date.now(), rows = [], keep = MAX_INCIDENTS } = {}) {
  if (!result?.drift) return { ok: false, skipped: true, error: "没有偏离，不落事件" };
  // 只摘要判定窗口内的 rows（调用方可能把整份审计 tail 传进来，别把几十年历史写进事件）。
  const windowMin = Number(result.stats?.windowMin) || 30;
  const since = now - windowMin * 60000;
  const inWindow = (Array.isArray(rows) ? rows : []).filter((r) => {
    const t = Number(r?.at ?? r?.ts);
    return Number.isFinite(t) && t >= since;
  });
  const incident = {
    id: newIncidentId(now),
    at: now,
    drift: true,
    issues: Array.isArray(result.issues) ? result.issues : [],
    stats: result.stats || {},
    rows: summarizeRows(inWindow, result.stats),
  };
  const limit = Math.max(1, Math.min(200, Number(keep) || MAX_INCIDENTS));
  const items = [incident, ...readItems(wsRoot)].slice(0, limit);
  try {
    atomicWriteJson(incidentsFile(wsRoot), { version: 1, updatedAt: now, items });
    return { ok: true, incident };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** 事件列表，新的在前。 */
export function listDriftIncidents(wsRoot, limit = MAX_INCIDENTS) {
  const n = Math.max(1, Math.min(200, Number(limit) || MAX_INCIDENTS));
  return readItems(wsRoot).slice(0, n);
}

export function latestDriftIncident(wsRoot) {
  return readItems(wsRoot)[0] || null;
}

export function getDriftIncident(wsRoot, id) {
  const wanted = text(id);
  if (!wanted) return null;
  return readItems(wsRoot).find((x) => x.id === wanted) || null;
}
