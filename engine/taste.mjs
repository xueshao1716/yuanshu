// engine/taste.mjs —— 品味库（2026-10-24）
//
// dsh-mood 的「品味库」是"判断的轨迹，跨会话带着看东西"。元枢原本只有 design-prefs（设计偏好），
// 只覆盖设计、且是开关式偏好。这里做成通用的**判断轨迹**：这次选了什么、否了什么、为什么，
// 事后可回看、可被后续会话带进上下文。
//
// 存 记忆/品味库.jsonl，一行一条；不进 git（在 记忆/ 下，本来就随工作区管理）。
import fs from 'node:fs';
import path from 'node:path';

const FILE = ['记忆', '品味库.jsonl'];
const MAX = 2000;

const fileOf = (wsRoot) => path.join(wsRoot, ...FILE);
const nowIso = () => new Date().toISOString();

function readAll(wsRoot) {
  try {
    return fs.readFileSync(fileOf(wsRoot), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
  } catch { return [] }
}

/** 记一条判断：chose 是选定的，rejected 是否掉的（可多个） */
export function recordTaste(wsRoot, { topic = '', chose = '', rejected = [], why = '', tags = [], source = 'agent' } = {}) {
  const t = String(topic || '').trim();
  const c = String(chose || '').trim();
  if (!t || !c) return { ok: false, error: '需要 topic 与 chose' };
  const entry = {
    at: nowIso(),
    topic: t.slice(0, 120),
    chose: c.slice(0, 200),
    rejected: (Array.isArray(rejected) ? rejected : [rejected]).filter(Boolean).map((x) => String(x).slice(0, 200)).slice(0, 5),
    why: String(why || '').slice(0, 300),
    tags: (Array.isArray(tags) ? tags : [tags]).filter(Boolean).map((x) => String(x).slice(0, 24)).slice(0, 6),
    source: source === 'user' ? 'user' : 'agent',
  };
  try {
    fs.mkdirSync(path.dirname(fileOf(wsRoot)), { recursive: true });
    fs.appendFileSync(fileOf(wsRoot), JSON.stringify(entry) + '\n', 'utf8');
    // 太长就截断到最近 MAX 条（重写文件，避免无限增长）
    const all = readAll(wsRoot);
    if (all.length > MAX) {
      fs.writeFileSync(fileOf(wsRoot), all.slice(-MAX).map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    }
    return { ok: true, entry };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

/** 最近 N 条（新的在前） */
export function listTaste(wsRoot, limit = 20) {
  return readAll(wsRoot).slice(-limit).reverse();
}

/** 按关键词搜（topic/chose/why/tags） */
export function searchTaste(wsRoot, q = '', limit = 20) {
  const key = String(q || '').trim().toLowerCase();
  const all = readAll(wsRoot);
  const hit = key
    ? all.filter((e) => `${e.topic} ${e.chose} ${(e.rejected || []).join(' ')} ${e.why} ${(e.tags || []).join(' ')}`.toLowerCase().includes(key))
    : all;
  return hit.slice(-limit).reverse();
}

/** 注入提示词用的紧凑文本：只给"判断"，不给长篇理由 */
export function tastePromptText(wsRoot, limit = 5) {
  const recent = listTaste(wsRoot, limit);
  if (!recent.length) return '';
  const lines = recent.map((e) => {
    const rej = (e.rejected || []).length ? `；否：${e.rejected.join('、')}` : '';
    const why = e.why ? `；因：${e.why.slice(0, 40)}` : '';
    return `- ${e.topic} → 选「${e.chose}」${rej}${why}`;
  });
  return `【品味库·最近 ${recent.length} 条判断（跨会话参考，不要照搬）】\n${lines.join('\n')}`;
}
