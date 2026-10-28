// ===== failure-ledger.mjs —— 共享的「这条路走不通」（2026-10-27）=====
//
// Agensh 共享上下文的最后一块：**失败尝试**也要写下来，后来的人才不会重复踩。
// 元枢原来失败只写进提案的 note 和日志里——下一个 agent 看不到，于是同一坑反复踩。
//
// 记录什么：谁、在哪块、试了什么、为什么不行、碰过哪些文件、证据在哪。
// 怎么用：开工前用 failure_recall 查一下「这块/这些文件之前失败过吗」。
import fs from "node:fs";
import path from "node:path";

export const LEDGER_REL = path.join("记忆", "运行时", "失败台账.json");
export const MAX_ENTRIES = 300;
export const SOURCES = ["patch", "gate", "claim", "manual", "tool"];
// 2026-10-28：同一件事累计失败到这个数，就判定「做不到」，不再重试
export const IMPOSSIBLE_THRESHOLD = 3;

const fileOf = (ws) => path.join(String(ws || "."), LEDGER_REL);

export function readFailures(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsRoot), "utf8"));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch {}
  return { v: 1, items: [] };
}

function writeFailures(wsRoot, data) {
  fs.mkdirSync(path.dirname(fileOf(wsRoot)), { recursive: true });
  fs.writeFileSync(fileOf(wsRoot), JSON.stringify({ ...data, v: 1, updatedAt: Date.now() }, null, 2), "utf8");
}

// 2026-10-27：中文整句切不出词——补二元组，和 memory-store 一个做法
const words = (s) => {
  const text = String(s || "").toLowerCase();
  const out = new Set();
  for (const m of text.matchAll(/[a-z0-9_][a-z0-9_.-]{1,}/g)) out.add(m[0]);
  const cjk = text.replace(/[^\u4e00-\u9fa5]+/g, " ");
  for (const chunk of cjk.split(/\s+/)) {
    if (chunk.length <= 2) { if (chunk.length === 2) out.add(chunk); continue }
    for (let i = 0; i + 1 < chunk.length; i += 1) out.add(chunk.slice(i, i + 2));
  }
  return [...out];
};

/**
 * 记一条失败。
 * @param {{wsRoot:string, agent?:string, area?:string, attempt:string, why:string,
 *          files?:string[], source?:string, evidence?:string, at?:number}} p
 */
export function recordFailure({ wsRoot, agent = "小语", area = "", attempt = "", why = "", files = [], source = "manual", evidence = "", kind = "", at = Date.now() } = {}) {
  const tried = String(attempt || "").trim().slice(0, 400);
  const reason = String(why || "").trim().slice(0, 400);
  if (!tried && !reason) return { ok: false, error: "attempt 和 why 至少填一个" };
  const entry = {
    id: `f-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at, agent: String(agent || "小语").slice(0, 40),
    area: String(area || "").slice(0, 80),
    attempt: tried, why: reason,
    files: (Array.isArray(files) ? files : [files]).map((f) => String(f || "").trim()).filter(Boolean).slice(0, 20),
    source: SOURCES.includes(source) ? source : "manual",
    kind: kind || undefined,   // "impossible" 表示「已判定做不到」
    evidence: String(evidence || "").slice(0, 200) || undefined,
  };
  const data = readFailures(wsRoot);
  data.items = [entry, ...(data.items || [])].slice(0, MAX_ENTRIES);
  writeFailures(wsRoot, data);
  return { ok: true, entry };
}

/**
 * 查「这条路之前踩过吗」：文件命中优先，其次关键词重叠。
 * @returns {Array<{entry:object, score:number, hitFiles:string[]}>}
 */
export function recallFailures({ wsRoot, text = "", files = [], limit = 5 } = {}) {
  const items = readFailures(wsRoot).items || [];
  const wantFiles = new Set((Array.isArray(files) ? files : [files]).map((f) => String(f || "").replace(/\\/g, "/").toLowerCase()).filter(Boolean));
  const wantWords = new Set(words(text));

  const fileHit = (a, b) => a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
  const wantList = [...wantFiles];
  const scored = items.map((e) => {
    const hitFiles = (e.files || []).filter((f) => {
      const n = String(f).replace(/\\/g, "/").toLowerCase();
      return wantList.some((w) => fileHit(n, w));
    });
    let score = hitFiles.length * 5;
    for (const w of words(`${e.area} ${e.attempt} ${e.why}`)) if (wantWords.has(w)) score += 1;
    return { entry: e, score, hitFiles };
  }).filter((x) => x.score > 0);

  scored.sort((a, b) => b.score - a.score || (b.entry.at || 0) - (a.entry.at || 0));
  return scored.slice(0, Math.max(1, limit));
}

/**
 * 同一件事失败了几次（按 area 归一 + 文件重叠）。
 * @returns {{times:number, lastAt:number, reasons:string[]}}
 */
export function countSimilar({ wsRoot, area = "", files = [] } = {}) {
  const wantArea = normArea(area);
  const wantFiles = new Set((Array.isArray(files) ? files : [files]).map((f) => String(f || "").replace(/\\/g, "/").toLowerCase()).filter(Boolean));
  const rows = (readFailures(wsRoot).items || []).filter((e) => {
    if (e.kind === "impossible") return false;   // 判定记录本身不计数
    if (wantArea && normArea(e.area) === wantArea) return true;
    return (e.files || []).some((f) => {
      const n = String(f).replace(/\\/g, "/").toLowerCase();
      return [...wantFiles].some((w) => n === w || n.endsWith("/" + w) || w.endsWith("/" + n));
    });
  });
  return {
    times: rows.length,
    lastAt: rows.length ? Math.max(...rows.map((e) => Number(e.at) || 0)) : 0,
    reasons: rows.slice(0, 3).map((e) => String(e.why || "").slice(0, 80)),
  };
}

const normArea = (a) => String(a || "").replace(/[（(].*?[）)]/g, "").replace(/\s+/g, "").slice(0, 40).toLowerCase();

/**
 * 判定「做不到」并留痕（之后开工前会先读这条）。
 */
export function markImpossible({ wsRoot, area = "", files = [], why = "", agent = "小语", at = Date.now() } = {}) {
  return recordFailure({
    wsRoot, agent, area: area || "未命名",
    attempt: "已判定做不到（停止重试）",
    why: why || `累计失败 ${IMPOSSIBLE_THRESHOLD} 次`,
    files, source: "manual", kind: "impossible", at: at === Date.now() ? Date.now() : at,
  });
}

/** 开工前问：这件事是不是已经被判定做不到？ */
export function isImpossible({ wsRoot, area = "", files = [] } = {}) {
  const wantArea = normArea(area);
  const rows = readFailures(wsRoot).items || [];
  const marks = rows.filter((e) => e.kind === "impossible" || /已判定做不到/.test(String(e.attempt || "")));
  const hit = marks.find((e) => (wantArea && normArea(e.area) === wantArea)
    || (e.files || []).some((f) => (Array.isArray(files) ? files : [files]).some((w) => String(w || "").replace(/\\/g, "/").toLowerCase().endsWith(String(f).replace(/\\/g, "/").toLowerCase()))));
  if (hit) return { impossible: true, at: hit.at, why: hit.why };
  // 没有显式标记，但累计失败已达阈值 → 也算做不到（调用方不必先自己统计）
  const c = countSimilar({ wsRoot, area, files });
  if (c.times >= IMPOSSIBLE_THRESHOLD) {
    return { impossible: true, auto: true, at: c.lastAt, why: `累计失败 ${c.times} 次：${c.reasons.join("；")}` };
  }
  return { impossible: false };
}

/** 失败后调用：没到阈值返回 needsMore；到了就落一条 impossible。 */
export function evaluateImpossible({ wsRoot, area = "", files = [], now = Date.now() } = {}) {
  const { times, reasons } = countSimilar({ wsRoot, area, files });
  if (times < IMPOSSIBLE_THRESHOLD) return { impossible: false, times, left: IMPOSSIBLE_THRESHOLD - times };
  const mark = markImpossible({ wsRoot, area, files, why: `累计失败 ${times} 次：${reasons.join("；")}`, at: now });
  return { impossible: true, times, mark };
}

/** 环境事实/开工提示：有相似失败才说一句。 */
export function failureLine({ wsRoot, text = "", files = [] } = {}) {
  const hits = recallFailures({ wsRoot, text, files, limit: 2 });
  if (!hits.length) return "";
  const head = hits.map((h) => `${h.entry.area || "之前"}：${String(h.entry.why || h.entry.attempt).slice(0, 40)}`).join("；");
  return `【踩过的坑】这件事有 ${hits.length} 条失败记录：${head}——动手前先看 failure_ledger，别重复踩。`;
}

export function recentFailures(wsRoot, { limit = 20 } = {}) {
  return (readFailures(wsRoot).items || []).slice(0, Math.max(1, limit));
}

/** 从补丁失败里抽一条：给 patch-runner 用。 */
export function recordPatchFailure({ wsRoot, proposal, stage, error, files = [], at = Date.now() } = {}) {
  return recordFailure({
    wsRoot, agent: "autopatch", area: `补丁：${proposal?.title || proposal?.id || "未命名"}`,
    attempt: `走自动补丁（阶段 ${stage}）`, why: String(error || "").slice(0, 300),
    files, source: stage === "gate" ? "gate" : "patch", at,
  });
}
