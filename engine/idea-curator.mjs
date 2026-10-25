// ===== idea-curator.mjs —— 「自己找活」（2026-10-25）=====
//
// 对标 Muse 的两块：
//   · Studying：每天围着已有目标/承诺做功课，看有哪些推不动的；
//   · Idea curation：每天长出一批建议，按可行性/合拍/新鲜打分，采纳了就变成目标。
//
// 元枢这里刻意**不用模型**（每天跑一次、要便宜且可预测）：
//   种子来自已经存在的真实记录（承诺、牵挂、定时任务、最近对话里"改天再说"这类句子），
//   打分是规则函数，理由可追溯——比让模型编三条"你今天应该做什么"更可信。
//
// 产出：记忆/运行时/今日建议.json（当天有效），采纳的进 lingxi（牵挂）台账，成为可追踪的目标。
import fs from "node:fs";
import path from "node:path";

export const IDEAS_FILE = path.join("记忆", "运行时", "今日建议.json");
/** 建议只在当天有意义；隔天不提示。 */
export const IDEAS_TTL_MS = 20 * 60 * 60 * 1000;
/** 每天最多推这么多条——多了就是噪音。 */
export const MAX_IDEAS = 3;

function ideasPath(wsRoot) { return path.join(String(wsRoot || "."), IDEAS_FILE); }

export function readIdeas(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(ideasPath(wsRoot), "utf8"));
    return raw && typeof raw === "object" ? raw : { generatedAt: 0, items: [] };
  } catch { return { generatedAt: 0, items: [] }; }
}

function writeIdeas(wsRoot, doc) {
  const file = ideasPath(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8");
  return doc;
}

/** 从最近对话里找"改天/以后/等有空"这类没落地的句子。 */
export function findDeferredMentions(texts = [], { now = Date.now(), max = 40 } = {}) {
  const RE = /(改天|以后|下次|有空|回头|找时间|等忙完|过几天|抽空|再说吧|待会再)/;
  const out = [];
  for (const t of texts) {
    if (!t || typeof t.text !== 'string') continue;
    const body = t.text.replace(/\s+/g, ' ').trim();
    if (body.length < 8) continue;
    const m = body.match(RE);
    if (!m) continue;
    // 取提到的那一句（前后各 30 字），太长就截断
    const at = body.indexOf(m[0]);
    const snippet = body.slice(Math.max(0, at - 30), Math.min(body.length, at + 40)).trim();
    out.push({ text: snippet, at: Number(t.at) || now, kind: 'deferred' });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 打分：可行性 0.4 / 合拍 0.3 / 新鲜 0.3。
 * 全部是可解释的规则，没有任何"模型觉得"。
 */
export function scoreIdea(idea, { now = Date.now(), tags = [] } = {}) {
  let feasibility = 0.4;
  if (idea.kind === 'promise') feasibility = 0.85;      // 已经答应过的事，最该做
  else if (idea.kind === 'task') feasibility = 0.7;      // 有定时任务说明本来就打算做
  else if (idea.kind === 'lingxi') feasibility = 0.6;    // 提过但没落地
  else if (idea.kind === 'deferred') feasibility = 0.5;  // 随口提的
  if (idea.hasDeadline) feasibility += 0.1;

  let fit = 0.3;
  const text = String(idea.text || '');
  const hitTags = (tags || []).filter((t) => t && text.includes(String(t)));
  if (hitTags.length) fit += Math.min(0.5, hitTags.length * 0.2);

  let freshness = 0.2;
  const ageMs = now - (Number(idea.at) || now);
  if (ageMs <= 7 * 24 * 3600 * 1000) freshness += 0.4;   // 最近一周提过
  if (ageMs <= 24 * 3600 * 1000) freshness += 0.2;
  if (idea.repeat >= 2) freshness += 0.2;                // 提过不止一次

  const score = Math.round((Math.min(1, feasibility) * 0.4 + Math.min(1, fit) * 0.3 + Math.min(1, freshness) * 0.3) * 100) / 100;
  return { score, parts: { feasibility: Math.min(1, feasibility), fit: Math.min(1, fit), freshness: Math.min(1, freshness) } };
}

/** 为什么要提这条（给用户看的理由，一行）。 */
function reasonOf(idea, parts) {
  if (idea.kind === 'promise') return `你答应过的事还没收尾（可行性 ${parts.feasibility.toFixed(2)}）`;
  if (idea.kind === 'task') return `定时任务一直在跑，但很久没有实际推进（可行性 ${parts.feasibility.toFixed(2)}）`;
  if (idea.kind === 'deferred') return `你之前随口说过「${String(idea.text).slice(0, 18)}…」，一直没落地（新鲜 ${parts.freshness.toFixed(2)}）`;
  return `提过但没落地（可行性 ${parts.feasibility.toFixed(2)}）`;
}

/**
 * 生成当天建议。幂等：同一天重复调用不会重复生成（除非 force）。
 * @returns {{generatedAt:number, items:object[], skipped?:string}}
 */
export function curateIdeas({ wsRoot, promises = [], lingxi = [], tasks = [], texts = [], tags = [], now = Date.now(), force = false } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const cur = readIdeas(wsRoot);
  if (!force && cur.generatedAt && new Date(cur.generatedAt).toISOString().slice(0, 10) === today) {
    return { ...cur, skipped: 'already_today' };
  }

  const seeds = [];
  for (const p of promises || []) {
    if (!p?.text) continue;
    seeds.push({ id: `promise:${p.id || p.text.slice(0, 12)}`, kind: 'promise', text: String(p.text), at: Date.parse(p.at || '') || now, hasDeadline: !!p.due });
  }
  for (const l of lingxi || []) {
    if (!l?.text || l.status === 'converted' || l.status === 'archived') continue;
    seeds.push({ id: `lingxi:${l.id}`, kind: 'lingxi', text: String(l.text), at: Date.parse(l.at || '') || now });
  }
  for (const t of tasks || []) {
    const last = Number(t.lastRun ? Date.parse(t.lastRun) : 0) || 0;
    if (!last) continue;
    if (now - last < 3 * 24 * 3600 * 1000) continue;      // 最近跑过的不提
    seeds.push({ id: `task:${t.id}`, kind: 'task', text: `${t.label || t.prompt || t.id}（上次 ${new Date(last).toISOString().slice(0, 10)}）`, at: last });
  }
  for (const d of findDeferredMentions(texts, { now })) {
    seeds.push({ id: `deferred:${d.text.slice(0, 16)}`, kind: 'deferred', text: d.text, at: d.at });
  }

  // 去重（同文本只留一条，记 repeat 次数）
  const byText = new Map();
  for (const s of seeds) {
    const key = s.text.replace(/\s+/g, '').slice(0, 40);
    const prev = byText.get(key);
    if (prev) { prev.repeat = (prev.repeat || 1) + 1; prev.at = Math.max(prev.at, s.at); }
    else byText.set(key, { ...s, repeat: 1 });
  }

  const scored = [...byText.values()].map((s) => {
    const { score, parts } = scoreIdea(s, { now, tags });
    return { ...s, score, parts, reason: reasonOf(s, parts) };
  }).sort((a, b) => b.score - a.score).slice(0, MAX_IDEAS);

  return writeIdeas(wsRoot, { generatedAt: now, items: scored });
}

/** 环境事实里的那一句（当天有效；没有就空串）。 */
export function ideasLine(wsRoot, { now = Date.now(), limit = 2 } = {}) {
  const doc = readIdeas(wsRoot);
  if (!doc.generatedAt || now - doc.generatedAt > IDEAS_TTL_MS) return '';
  const items = (doc.items || []).slice(0, limit);
  if (!items.length) return '';
  const head = items.map((x) => `${x.text.slice(0, 24)}（${x.score}）`).join('；');
  return `【今日建议】${items.length} 条候选目标：${head}。这些是我从承诺/牵挂/最近对话里挑的，不急着做；她可以问一句要不要推进，采纳了就用 lingxi 记成目标。`;
}

/** 采纳 → 进牵挂台账，变成可追踪目标。 */
export function acceptIdea({ wsRoot, id, addLingXi, now = Date.now() } = {}) {
  const doc = readIdeas(wsRoot);
  const hit = (doc.items || []).find((x) => x.id === id);
  if (!hit) return { ok: false, error: '没有这条建议（可能今天还没生成）' };
  if (typeof addLingXi !== 'function') return { ok: false, error: '牵挂台账未接入' };
  const r = addLingXi(wsRoot, { text: String(hit.text).slice(0, 200), source: 'user', note: `今日建议采纳（分 ${hit.score}）` });
  doc.items = (doc.items || []).filter((x) => x.id !== id);
  doc.acceptedAt = now;
  writeIdeas(wsRoot, doc);
  return { ok: true, lingxi: r };
}

/** 不要这条（当天不再出现）。 */
export function dismissIdea({ wsRoot, id, now = Date.now() } = {}) {
  const doc = readIdeas(wsRoot);
  const before = (doc.items || []).length;
  doc.items = (doc.items || []).filter((x) => x.id !== id);
  if (doc.items.length === before) return { ok: false, error: '没有这条建议' };
  doc.dismissedAt = now;
  writeIdeas(wsRoot, doc);
  return { ok: true, left: doc.items.length };
}
