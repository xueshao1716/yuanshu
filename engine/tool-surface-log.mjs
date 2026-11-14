// ===== tool-surface-log.mjs —— 每轮工具表快照 + 工具失败的台账入口（2026-11-14）=====
//
// 盲区一（本轮补）：昨天「派活工具被裁 8 天没人发现」之所以拖了 8 天，是因为
// **没有任何地方记录「这一轮实际下发了哪些工具」**——只能靠翻会话原文反推。
// 现在在组装每轮工具表的唯一一处（unified-chat.mjs 调用 filterToolsByTier 的地方）
// 落一行快照到 记忆/运行时/工具表.jsonl：
//   { at, sessionId(后 6 位), tier, total, sent, dropped: [名字…最多 10 个], droppedTotal }
// 去重按内容哈希（tier/total/sent/dropped 同一份就不再写），最多留 MAX_SURFACE_LINES 行。
// 日志只在**真的写入**时打一行 `[tools] sent=24/63 tier=0.5 dropped=12`：
// 正常轮次的工具表不变 → 不写盘也不打日志，没有噪音。
//
// 盲区二（本轮补）：失败台账在 10-28 之后停更，不是「没有新失败」——工具超时
// （bash 120s、generate_video 180s）和 verify_check 断言未过都只是把 isError 回给模型，
// 从来没人写台账（台账只有 patch / gate / manual 三个写入口，`source: "tool"` 早在
// SOURCES 里留着却没人传）。这里补上 recordToolFailure：只收**硬失败**，普通非零退出
// （grep 没命中）不算，避免台账被噪声灌满。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { recordFailure, readFailures } from "./failure-ledger.mjs";

export const SURFACE_REL = path.join("记忆", "运行时", "工具表.jsonl");
export const MAX_SURFACE_LINES = 2000;     // 超出按行裁剪（保留最近 2000 行）
export const MAX_DROPPED_NAMES = 10;       // dropped 最多记 10 个名字，另记总数
export const TOOL_FAILURE_DEDUPE_MS = 30 * 60 * 1000;  // 同一形态失败 30 分钟内只记一条
export const TOOL_FAILURE_TURN_CAP = 5;    // 单轮最多落 5 条，防一次循环刷屏

const toolName = (t) => String(t?.function?.name || t?.name || "").trim();
const namesOf = (list) => (Array.isArray(list) ? list : []).map(toolName).filter(Boolean);
const surfaceFile = (wsRoot) => path.join(String(wsRoot || "."), SURFACE_REL);

/** 内容哈希：只认「这一轮下发了什么」，不含 at / sessionId（否则每轮都不一样，去重永远失效）。 */
export function surfaceFingerprint(entry = {}) {
  const dropped = Array.isArray(entry?.dropped) ? entry.dropped.map(String) : [];
  const total = Number(entry?.total) || 0;
  const sent = Number(entry?.sent) || 0;
  const droppedTotal = Number.isFinite(Number(entry?.droppedTotal)) ? Number(entry.droppedTotal) : Math.max(0, total - sent);
  const tier = entry?.tier === null || entry?.tier === undefined ? null : Number(entry.tier);
  return createHash("sha256").update(JSON.stringify([tier, total, sent, droppedTotal, dropped])).digest("hex").slice(0, 16);
}

/** 组一条快照。tier 取不到写 null；dropped 只留前 10 个名字 + 总数。 */
export function buildSurfaceEntry({ at = new Date().toISOString(), sessionId = "", tier = null, allTools = [], sentTools = [] } = {}) {
  const all = namesOf(allTools);
  const sentNames = namesOf(sentTools);
  const sentSet = new Set(sentNames);
  const droppedAll = [...new Set(all.filter((n) => !sentSet.has(n)))];
  const tierNum = tier === null || tier === undefined || tier === "" ? null : Number(tier);
  return {
    at: String(at || new Date().toISOString()),
    sessionId: String(sessionId || "").slice(-6),
    tier: Number.isFinite(tierNum) ? tierNum : null,
    total: all.length,
    sent: sentNames.length,
    dropped: droppedAll.slice(0, MAX_DROPPED_NAMES),
    droppedTotal: droppedAll.length,
  };
}

/** 日志一行：`[tools] sent=24/63 tier=0.5 dropped=12`。 */
export function formatToolSurfaceLine(entry = {}) {
  const tier = entry?.tier === null || entry?.tier === undefined ? "null" : String(entry.tier);
  const droppedTotal = Number.isFinite(Number(entry?.droppedTotal))
    ? Number(entry.droppedTotal)
    : Math.max(0, (Number(entry?.total) || 0) - (Number(entry?.sent) || 0));
  return `[tools] sent=${Number(entry?.sent) || 0}/${Number(entry?.total) || 0} tier=${tier} dropped=${droppedTotal}`;
}

function readLines(file) {
  try { return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()); } catch { return []; }
}

function parseLine(line) {
  try { const v = JSON.parse(line); return v && typeof v === "object" ? v : null; } catch { return null; }
}

/**
 * 记一行快照。与上一条内容相同 → 不写盘、不打日志。
 * @returns {{ok:boolean, written:boolean, duplicate?:boolean, entry?:object, line?:string, error?:string}}
 */
export function recordToolSurface({ wsRoot, sessionId = "", tier = null, allTools = [], sentTools = [], at = new Date().toISOString() } = {}) {
  try {
    const root = String(wsRoot || "").trim();
    // 没有工作区根就不写（测试/嵌入场景常不注入 wsRoot，别把快照写到进程 cwd 的仓库里）
    if (!root) return { ok: false, written: false, skipped: "no-workspace" };
    const entry = buildSurfaceEntry({ at, sessionId, tier, allTools, sentTools });
    const file = surfaceFile(root);
    const lines = readLines(file);
    const last = lines.length ? parseLine(lines[lines.length - 1]) : null;
    if (last && surfaceFingerprint(last) === surfaceFingerprint(entry)) {
      return { ok: true, written: false, duplicate: true, entry };
    }
    const next = [...lines, JSON.stringify(entry)];
    const overflow = next.length > MAX_SURFACE_LINES;
    const kept = overflow ? next.slice(-MAX_SURFACE_LINES) : next;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, kept.join("\n") + "\n", "utf8");
    const line = formatToolSurfaceLine(entry);
    try { console.log(line); } catch {}
    return { ok: true, written: true, duplicate: false, entry, line, trimmed: overflow, lines: kept.length };
  } catch (e) {
    return { ok: false, written: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 读最近 N 条（新的在前），给 GET /api/tools/surface 用。 */
export function readToolSurface(wsRoot, { limit = 20 } = {}) {
  const max = Math.max(1, Math.min(MAX_SURFACE_LINES, Number(limit) || 20));
  const lines = readLines(surfaceFile(wsRoot));
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < max; i -= 1) {
    const entry = parseLine(lines[i]);
    if (entry) out.push(entry);
  }
  return out;
}

/** 只读接口：GET /api/tools/surface?limit=20（鉴权在 server 统一那层，路由本身不碰写）。 */
export function handleToolSurfaceRoute(res, req, url, { wsRoot = ".", json } = {}) {
  try {
    const raw = Number(url?.searchParams?.get?.("limit"));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(200, Math.floor(raw)) : 20;
    const items = readToolSurface(wsRoot, { limit });
    return json(res, 200, { ok: true, file: SURFACE_REL.replace(/\\/g, "/"), maxLines: MAX_SURFACE_LINES, count: items.length, items });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e).slice(0, 240) });
  }
}

// ── 工具失败 → 失败台账 ────────────────────────────────────────────────

/**
 * 值不值得进台账：只收硬失败（超时 / verify_check 断言未过 / 执行器异常）。
 * 不收：普通非零退出（grep 没命中、git status 非干净）、参数/schema/红线前置拒绝。
 */
export function isLedgerWorthyToolFailure(name, out) {
  if (!out || out?.isError !== true) return false;
  if (out?.denied === true) return false;
  const text = String(out?.text || "").trim();
  if (!text) return false;
  if (/^⛔/.test(text)) return false;
  if (String(name || "") === "verify_check") return true;
  if (/超时|超过\s*\d+\s*秒|TOOL_TIMEOUT|timeout|timed ?out/i.test(text)) return true;
  // 读/写/改的目标不存在：真实失败（也是"故意读一个不存在的文件"能验到的那一类）。
  if (/文件不存在或不可读|文件不存在或路径越权/.test(text)) return true;
  if (/^(命令执行失败|工具执行失败|工具调用失败|生成失败|执行失败|请求失败|下载失败)/.test(text)) return true;
  return false;
}

/**
 * 把一次工具硬失败落进失败台账（source="tool"，入库即归因）。
 * 同一 area + 同一错误文本 + 同一目标，30 分钟内只记一条（工具循环重试不刷屏）。
 * @returns {{ok:boolean, skipped?:string, entry?:object, error?:string}}
 */
export function recordToolFailure({ wsRoot, name = "", out = null, args = null, sessionId = "", at = Date.now() } = {}) {
  try {
    if (!isLedgerWorthyToolFailure(name, out)) return { ok: false, skipped: "not-worthy" };
    const root = String(wsRoot || "").trim();
    if (!root) return { ok: false, skipped: "no-workspace" };
    const why = String(out?.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!why) return { ok: false, skipped: "empty" };
    const files = [];
    const targets = [
      args?.path, args?.file, args?.cwd,
      ...(Array.isArray(args?.claims) ? args.claims.map((c) => c?.target) : []),
    ];
    for (const raw of targets) {
      const s = String(raw || "").trim();
      if (!s || path.isAbsolute(s) || s.includes("..") || files.includes(s)) continue;
      files.push(s);
      if (files.length >= 5) break;
    }
    const area = `工具：${String(name || "未知")}`;
    const hint = String(args?.command || args?.cmd || args?.path || args?.file || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const attempt = `调用 ${String(name || "未知")}${hint ? `（${hint}）` : ""}${sessionId ? ` · 会话 ${String(sessionId).slice(-6)}` : ""}`;
    // 持久化去重：进程重启后同一形态失败也不重复记（只读最近台账，成本可忽略）。
    let prior = [];
    try { prior = readFailures(root).items || []; } catch { prior = []; }
    const dup = prior.find((e) => e?.source === "tool" && e?.area === area && e?.why === why
      && Math.abs(Number(e?.at || 0) - at) < TOOL_FAILURE_DEDUPE_MS
      && String(e?.attempt || "").slice(0, 80) === attempt.slice(0, 80));
    if (dup) return { ok: true, skipped: "duplicate", entry: dup };
    return recordFailure({
      wsRoot: root, agent: "小语", area, attempt, why, files, source: "tool",
      evidence: out?.code ? String(out.code).slice(0, 60) : "", at,
    });
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
