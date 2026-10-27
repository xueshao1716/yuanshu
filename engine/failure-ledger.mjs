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
export function recordFailure({ wsRoot, agent = "小语", area = "", attempt = "", why = "", files = [], source = "manual", evidence = "", at = Date.now() } = {}) {
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
