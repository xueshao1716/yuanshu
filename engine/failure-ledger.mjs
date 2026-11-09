// ===== failure-ledger.mjs —— 共享的「这条路走不通」（2026-10-27）=====
//
// Agensh 共享上下文的最后一块：**失败尝试**也要写下来，后来的人才不会重复踩。
// 元枢原来失败只写进提案的 note 和日志里——下一个 agent 看不到，于是同一坑反复踩。
//
// 记录什么：谁、在哪块、试了什么、为什么不行、碰过哪些文件、证据在哪。
// 怎么用：开工前用 failure_recall 查一下「这块/这些文件之前失败过吗」。
//
// 2026-11-09（失败归因，出处 xinyu-hermes replay_writer.py:31-38）：
// 每条新失败入库时自动打四类标签（failure-attribution.mjs）；只有 skill_noncompliant /
// skill_knowledge_gap 是可改进信号，才会进「改进队列」并落一条教训候选。
// 其余两类（任务不可能 / 工具不够）只留档，不进改进队列——避免"改了也白改"的噪声。
import fs from "node:fs";
import path from "node:path";
import {
  classifyFailure, dedupeFailures, enqueueImprovement, attributionReport, listImprovementQueue,
  DEDUPE_THRESHOLD,
} from "./failure-attribution.mjs";

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
 * 入库即归因（四类之一 + isSignal）；isSignal 的自动进「改进队列」。
 * @param {{wsRoot:string, agent?:string, area?:string, attempt:string, why:string,
 *          files?:string[], source?:string, evidence?:string, at?:number,
 *          ctx?:{skills?:Array, knowledge?:Array, retrySucceeded?:boolean, retry?:object,
 *                environmental?:boolean, envFailures?:number, priorFailures?:Array}}} p
 * @returns {{ok:boolean, entry?:object, attribution?:object, improvement?:object|null, error?:string}}
 */
export function recordFailure({
  wsRoot, agent = "小语", area = "", attempt = "", why = "", files = [], source = "manual",
  evidence = "", kind = "", at = Date.now(), ctx = {},
} = {}) {
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
  const prior = Array.isArray(data.items) ? data.items : [];
  // 归因只读台账里已有的真实字段：别处传进来的 ctx（技能/知识/重试结果）优先，priorFailures 默认用台账。
  let attribution;
  try {
    attribution = classifyFailure(entry, { ...(ctx || {}), priorFailures: (ctx && ctx.priorFailures) || prior, now: at });
  } catch (e) {
    // 归因失败不能挡住记账（元枢的纪律：闸门自己出错一律放行）
    attribution = { kind: "task_impossible", isSignal: false, reason: `归因异常：${String(e?.message || e).slice(0, 120)}`, confidence: 0, evidence: [] };
  }
  entry.attribution = attribution;
  data.items = [entry, ...prior].slice(0, MAX_ENTRIES);
  writeFailures(wsRoot, data);

  let improvement = null;
  if (attribution.isSignal === true) {
    try { improvement = enqueueImprovement({ wsRoot, entry, attribution, now: at }); }
    catch (e) { improvement = { ok: false, error: String(e?.message || e).slice(0, 160) }; }
  }
  return { ok: true, entry, attribution, improvement };
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
  // 去重合并过的条目带 occurrences：次数按"实际发生"算，不然 prune 之后永远到不了阈值。
  const times = rows.reduce((sum, e) => sum + Math.max(1, Number(e.occurrences) || 1), 0);
  return {
    times,
    lastAt: rows.length ? Math.max(...rows.map((e) => Number(e.lastAt) || Number(e.at) || 0)) : 0,
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

// ── 归因看板 / 去重（2026-11-09）─────────────────────────────────

/**
 * 看板数据：四类分布 + 最近条目 + 改进队列。
 * 旧条目（归因功能上线前记的）没有 attribution，现场归因一次（标 inferred）。
 * @returns {{ok:true, distribution:object, signal:number, nonSignal:number, needsReview:number, recent:Array, queue:Array}}
 */
export function failureAttribution({ wsRoot, limit = 20 } = {}) {
  const items = readFailures(wsRoot).items || [];
  const report = attributionReport({ items, limit: Math.max(1, Math.min(200, Number(limit) || 20)) });
  return {
    ...report,
    queue: listImprovementQueue(wsRoot, { limit: 20 }).map((q) => ({
      id: q.id, kind: q.kind, area: q.area, why: q.why, occurrences: q.occurrences || 1,
      status: q.status, at: q.at, lastAt: q.lastAt,
    })),
  };
}

/**
 * 相似失败去重（≥threshold 合并，参考 hermes replay_writer 的 --prune）。
 * 默认 dryRun：只报会合并几组，不动台账；要真合并传 dryRun:false。
 * 合并保留 "occurrences" 计数，countSimilar / isImpossible 的阈值语义不变。
 * @returns {{ok:boolean, dryRun:boolean, before:number, after:number, mergedCount:number, merged:Array, file?:string}}
 */
export function pruneFailures({ wsRoot, threshold = DEDUPE_THRESHOLD, dryRun = true } = {}) {
  const data = readFailures(wsRoot);
  const before = (data.items || []).length;
  const out = dedupeFailures(data.items || [], { threshold });
  if (!dryRun) {
    data.items = out.items.slice(0, MAX_ENTRIES);
    writeFailures(wsRoot, data);
  }
  return {
    ok: true, dryRun: !!dryRun, before, after: out.items.length,
    mergedCount: out.mergedCount, merged: out.merged,
    file: dryRun ? undefined : fileOf(wsRoot),
  };
}

/** 从补丁失败里抽一条：给 patch-runner 用。 */
export function recordPatchFailure({ wsRoot, proposal, stage, error, files = [], at = Date.now() } = {}) {
  return recordFailure({
    wsRoot, agent: "autopatch", area: `补丁：${proposal?.title || proposal?.id || "未命名"}`,
    attempt: `走自动补丁（阶段 ${stage}）`, why: String(error || "").slice(0, 300),
    files, source: stage === "gate" ? "gate" : "patch", at,
  });
}

/**
 * 交付/验收关口挡下的一次改动：落失败台账（source=gate），入库即归因。
 * 调用点：self-change-admit 的自证失败 / 棘轮未过 / 评估器未过（不阻断准入流程）。
 */
export function recordGateFailure({ wsRoot, stage = "gate", area = "", reason = "", files = [], evidence = "", at = Date.now(), ctx = {} } = {}) {
  return recordFailure({
    wsRoot, agent: "admit",
    area: area || `验收：${stage}`,
    attempt: `走自改准入（阶段 ${stage}）`,
    why: String(reason || "").slice(0, 300),
    files, source: "gate", evidence, at, ctx,
  });
}
