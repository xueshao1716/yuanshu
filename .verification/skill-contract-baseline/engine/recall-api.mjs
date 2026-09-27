// engine/recall-api.mjs —— 跨会话回忆（09-04，Hermes FTS5 思想 + EvoX SessionSummary 的零依赖落地）
// 闭环第三件：「上次那事怎么解决的？」→ 跨所有会话检索 + LLM 综合回答（带出处）
// 三层：①片段索引（jsonl 抽片段 → 中文 bigram 倒排，增量重建）②会话摘要（LLM 一句话，缓存）
//      ③回忆问答（检索 top 片段 → LLM 综合注明出处）
// 持久化 {agentDir}/session-recall.json；红线：只读会话文件，绝不写回。
import fs from "node:fs";
import path from "node:path";
import { json } from "./http-utils.mjs";
import { getSessionList } from "./session-files.mjs";

let _agentDir = "", _chat = null, _getDefaultModel = null;
let _index = null; // { files:{id:{mtimeMs,size}}, snippets:[], grams:{} }

export function initRecallApi({ agentDir = "", chat = null, getDefaultModel = null } = {}) {
  _agentDir = agentDir; _chat = chat; _getDefaultModel = getDefaultModel;
}

function indexFile() { return path.join(_agentDir, "session-recall.json"); }
function loadIndex() {
  if (_index) return _index;
  try { _index = JSON.parse(fs.readFileSync(indexFile(), "utf8")); } catch { _index = {}; }
  _index.files ||= {}; _index.snippets ||= []; _index.grams ||= {}; _index.summaries ||= {};
  return _index;
}
function saveIndex() { try { fs.writeFileSync(indexFile(), JSON.stringify(_index)); } catch {} }

// ── 中文 bigram + 英文数字词 分词 ──
export function tokenize(text) {
  const out = new Set();
  const t = String(text || "").toLowerCase();
  const latin = t.match(/[a-z0-9_]+/g) || [];
  for (const w of latin) { out.add(w); if (w.length > 5) for (let i = 0; i + 4 <= w.length; i += 3) out.add(w.slice(i, i + 4)); }
  const cjkRuns = t.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) { out.add(run); continue; }
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out].filter(g => g.length >= 1 && g.length <= 24);
}

// ── entries → 片段（user 全抽截 240 字；assistant 抽文本截 200 字；大文件三段采样）──
export function snippetsFromEntries(entries, cap = 120) {
  const all = [];
  for (const e of entries) {
    if (e?.type !== "message" || !e.message) continue;
    const role = e.message.role;
    if (role !== "user" && role !== "assistant") continue;
    let text = "";
    const c = e.message.content;
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.map(p => (typeof p === "string" ? p : p?.text || "")).join(" ");
    text = String(text).replace(/\s+/g, " ").trim();
    if (!text || text.length < 6) continue;
    if (/^\{[\s\S]*\}$/.test(text) && text.length > 500) continue; // 大 JSON 块跳过
    all.push({ role, text: role === "user" ? text.slice(0, 240) : text.slice(0, 200), ts: e.message.timestamp || null });
  }
  if (all.length <= cap) return all;
  const head = all.slice(0, 30), tail = all.slice(-60);
  const mid = all.slice(30, -60);
  const step = Math.max(1, Math.ceil(mid.length / Math.max(1, cap - 90)));
  const midSampled = mid.filter((_, i) => i % step === 0);
  return [...head, ...midSampled, ...tail].slice(0, cap);
}

function snippetId(file, i) { return `${path.basename(file)}#${i}`; }

// ── 增量索引构建：mtime+size 变了的会话才重抽 ──
export function rebuildIndex({ force = false } = {}) {
  const idx = loadIndex();
  const sessions = getSessionList();
  let rebuilt = 0, total = 0;
  const aliveIds = new Set();
  const freshSnips = new Map(); // sessionId → 新片段（不污染会话缓存对象）
  for (const s of sessions) {
    aliveIds.add(s.id);
    total++;
    let st = null;
    try { st = fs.statSync(s.file); } catch { continue; }
    const sig = { mtimeMs: Math.round(st.mtimeMs), size: st.size };
    const prev = idx.files[s.id];
    if (!force && prev && prev.mtimeMs === sig.mtimeMs && prev.size === sig.size) continue;
    // 重抽该会话
    let entries = [];
    try {
      const lines = fs.readFileSync(s.file, "utf8").split("\n").filter(Boolean);
      entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { continue; }
    const snips = snippetsFromEntries(entries);
    idx.snippets = idx.snippets.filter(x => x.sid !== s.id); // 删旧片段（倒排最后统一重建）
    idx.files[s.id] = { ...sig, name: s.name || "", cwd: s.cwd || "" };
    freshSnips.set(s.id, snips);
    rebuilt++;
  }
  // 清理已消失的会话
  for (const id of Object.keys(idx.files)) if (!aliveIds.has(id)) { idx.snippets = idx.snippets.filter(x => x.sid !== id); delete idx.files[id]; }
  // 统一重建倒排（片段量级 ~1e4，全量重建毫秒级，比增量修补倒排可靠）
  for (const [sid, snips] of freshSnips) {
    for (let i = 0; i < snips.length; i++) {
      const sn = snips[i];
      idx.snippets.push({ sid, name: idx.files[sid]?.name || "", role: sn.role, text: sn.text, ts: sn.ts, line: i });
    }
  }
  idx.grams = {};
  idx.snippets.forEach((sn, i) => {
    for (const g of tokenize(sn.text)) (idx.grams[g] ||= []).push(i);
  });
  idx.lastRebuild = new Date().toISOString();
  saveIndex();
  return { ok: true, total, rebuilt, snippets: idx.snippets.length, grams: Object.keys(idx.grams).length };
}

// ── 检索打分：命中 gram 覆盖率 + role 权重 + 新鲜度 ──
export function scoreSnippets(idx, q, limit = 12) {
  const grams = tokenize(q);
  if (!grams.length) return [];
  const hit = new Map(); // idx -> score
  for (const g of grams) {
    const arr = idx.grams[g];
    if (!arr) continue;
    for (const i of arr) hit.set(i, (hit.get(i) || 0) + 1);
  }
  const now = Date.now();
  const results = [];
  for (const [i, hits] of hit) {
    const sn = idx.snippets[i];
    if (!sn) continue;
    const own = tokenize(sn.text).length || 1;
    const coverage = hits / Math.min(grams.length, own);
    const roleBoost = sn.role === "user" ? 1.15 : 1.0;
    const ageDays = sn.ts ? (now - new Date(sn.ts).getTime()) / 86400000 : 30;
    const fresh = 1 / (1 + Math.max(0, ageDays) / 30);
    results.push({ score: coverage * roleBoost * (0.6 + 0.4 * fresh), sn });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ score, sn }) => ({ ...sn, score: +score.toFixed(3) }));
}

export function handleRecall(res, url) {
  const q = String(url.searchParams.get("q") || "").trim();
  if (!q) return json(res, 400, { error: "缺 q" });
  const idx = loadIndex();
  const hits = scoreSnippets(idx, q, 12);
  json(res, 200, { q, total: idx.snippets.length, hits });
}

// ── 回忆问答：检索 top8 → LLM 综合注明出处 ──
export async function handleRecallAsk(res, body) {
  const q = String(body?.q || "").trim();
  if (!q) return json(res, 400, { error: "缺 q" });
  const model = _getDefaultModel ? _getDefaultModel() : null;
  if (!_chat || !model) return json(res, 503, { error: "LLM 未注入" });
  const idx = loadIndex();
  const hits = scoreSnippets(idx, q, 8);
  if (!hits.length) return json(res, 200, { answer: "没找到相关的历史会话记录。", hits: [] });
  const context = hits.map((h, i) => `[${i + 1}] 会话「${h.name || h.sid}」${h.role === "user" ? "用户说" : "小语说"}：${h.text}`).join("\n\n");
  const r = await _chat(model, [
    { role: "system", content: "你是回忆助手。根据提供的跨会话历史片段回答用户的问题。要求：①只用片段里有的信息，不要编造 ②在关键结论后标注来源编号如 [2] ③片段不足以回答时直说 ④简洁，不超过 200 字。" },
    { role: "user", content: `# 历史会话片段\n${context}\n\n# 问题\n${q}` },
  ]);
  if (!r || r.error) return json(res, 502, { error: "回忆综合失败: " + String(r?.error || "空响应").slice(0, 80) });
  json(res, 200, { answer: String(r.text || "").trim(), hits });
}

// ── 会话摘要（EvoX SessionSummary）：LLM 一句话，缓存，批量限量 ──
export function handleSummaries(res) {
  const idx = loadIndex();
  json(res, 200, { summaries: idx.summaries, generatedAt: idx.summariesAt || null });
}

export async function buildSummaries({ count = 5 } = {}) {
  const model = _getDefaultModel ? _getDefaultModel() : null;
  if (!_chat || !model) return { error: "LLM 未注入" };
  const idx = loadIndex();
  const sessions = getSessionList();
  let done = 0;
  for (const s of sessions) {
    if (done >= count) break;
    if (idx.summaries[s.id]) continue;
    let entries = [];
    try {
      const lines = fs.readFileSync(s.file, "utf8").split("\n").filter(Boolean).slice(0, 60);
      entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { continue; }
    const msgs = entries.filter(e => e?.type === "message" && e.message?.role && e.message?.role !== "system");
    if (msgs.length < 6) { idx.summaries[s.id] = "(过短会话)"; continue; }
    const convo = msgs.slice(0, 20).map(m => `${m.message.role}: ${String(typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content)).replace(/\s+/g, " ").slice(0, 150)}`).join("\n");
    const r = await _chat(model, [
      { role: "system", content: "用一句不超过 40 字的中文概括这段对话做了什么（做了什么/产出什么/结论是什么）。只输出这句话。" },
      { role: "user", content: convo.slice(0, 3500) },
    ]);
    if (r && !r.error && r.text) { idx.summaries[s.id] = String(r.text).replace(/\s+/g, " ").trim().slice(0, 60); done++; }
  }
  idx.summariesAt = new Date().toISOString();
  saveIndex();
  return { ok: true, generated: done, totalKnown: Object.keys(idx.summaries).length };
}

export function recallStats() {
  const idx = loadIndex();
  return { sessions: Object.keys(idx.files).length, snippets: idx.snippets.length, grams: Object.keys(idx.grams).length, summaries: Object.keys(idx.summaries).length, lastRebuild: idx.lastRebuild || null };
}
