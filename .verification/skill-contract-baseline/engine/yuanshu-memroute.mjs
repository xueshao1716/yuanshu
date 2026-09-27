// 文本工作台版 VoiceMem 左脑：先按 Schema/实体缩小，再 Top-5。不接向量库。
export const MEMORY_TOP_K = 5;

function tokenize(str) {
  const out = [];
  const s = String(str || "");
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_.\-]{1,}|\d{2,}/g)) out.push(m[0].toLowerCase());
  const segs = s.replace(/[A-Za-z0-9_\-./:]/g, " ").split(/\s+/).filter((x) => /[\u4e00-\u9fff]/.test(x));
  for (const seg of segs) {
    const ch = seg.replace(/[^\u4e00-\u9fff]/g, "");
    if (!ch) continue;
    if (ch.length <= 2) out.push(ch);
    else for (let i = 0; i < ch.length - 1; i++) out.push(ch.slice(i, i + 2));
  }
  return [...new Set(out)];
}

export function extractEntities(text, schemas = []) {
  const s = String(text || "");
  const out = [];
  for (const sch of schemas) {
    const name = String(sch || "").trim();
    if (name.length >= 2 && s.includes(name)) out.push(name);
  }
  const re = /(?:对|跟|和|关于)([\u4e00-\u9fffA-Za-z0-9_\-]{2,12}?)(?:的|很|有点|特别|说|聊|生气|烦|紧张|焦虑|喜欢|讨厌|[，。！？、\s]|$)/g;
  for (const m of s.matchAll(re)) {
    const name = String(m[1] || "").trim();
    if (name && !/^(什么|这个|那个|自己|我们|他们|东西)/.test(name)) out.push(name);
  }
  return [...new Set(out)].slice(0, 4);
}

export function routeMemory({ query = "", candidates = [], entities = [], k = MEMORY_TOP_K } = {}) {
  const qTok = tokenize(query);
  if (!qTok.length || !Array.isArray(candidates) || !candidates.length) return [];
  const ent = (entities || []).map((e) => String(e || "").trim()).filter((e) => e.length >= 2);
  const scored = [];
  for (const c of candidates) {
    const text = String(c?.text || "").trim();
    if (!text) continue;
    const tTok = new Set(tokenize(text));
    let hits = 0;
    for (const t of qTok) if (tTok.has(t)) hits++;
    let bonus = 0;
    for (const e of ent) {
      if (text.includes(e)) bonus += 3;
      if (query.includes(e) && text.includes(e)) bonus += 2;
    }
    const score = hits + bonus;
    if (score <= 0) continue;
    scored.push({ text, score, source: c.source || "" });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const row of scored) {
    const key = row.text.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row.text);
    if (out.length >= Math.max(1, k)) break;
  }
  return out;
}
