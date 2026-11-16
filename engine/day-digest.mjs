// engine/day-digest.mjs —— 每日对话摘要（2026-11-16）
//
// 为什么要有它：心情日记按天写，但只记情绪；跨会话回忆的一句话摘要只看会话开头 20 条。
// 一条会话聊好几天时，后面几天的事哪里都没留下——问"11 月 8 号聊了什么"只能靠关键词碰运气。
//
// 约定（照心情日记）：
//   · 落盘 记忆/每日摘要/YYYY-MM-DD.md；只写过去的日子，已存在就跳过（除非 force）
//   · 按消息自身的时间戳切天，不按会话切——一条长会话会分进它跨过的每一天
//   · 摘要优先走注入的 summarize（辅助模型）；失败或没注入就写规则版（列当天各会话的用户原话），不空着
//   · 用户这句话提到日期（昨天/前天/11月8日/11-08）时，dayDigestNote 把那天的摘要给本轮记忆段
import fs from 'node:fs';
import path from 'node:path';

const DIR = ['记忆', '每日摘要'];
const DAY_MS = 86400_000;
const localDate = (d) => {
  try { return new Date(d).toLocaleDateString('sv-SE') } catch { return new Date(d).toISOString().slice(0, 10) }
};
const pad = (n) => String(n).padStart(2, '0');

export function digestPath(wsRoot, date) { return path.join(wsRoot, ...DIR, `${date}.md`) }

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text || '' : '')).join(' ');
}

// 微信桥会在用户消息前拼一段「【微信环境·必读】…【对方消息】」，只留对方真正说的话
function userSaid(text) {
  const mark = text.lastIndexOf('【对方消息】');
  return mark >= 0 ? text.slice(mark + '【对方消息】'.length).trim() : text;
}

/**
 * 一次扫完所有会话，按本地日期分组：Map(date → [{ sid, name, items:[{ role, text, ts }] }])。
 * 586 个会话同步读一遍约 1.7s，所以只扫一遍、每 20 个文件让一次事件循环。
 */
export async function collectDays(sessions = [], dates = []) {
  const want = new Set(dates);
  const byDate = new Map(dates.map((d) => [d, []]));
  if (!want.size) return byDate;
  const earliest = Math.min(...dates.map((d) => new Date(`${d}T00:00:00`).getTime()));
  let n = 0;
  for (const s of sessions) {
    if (!s?.file) continue;
    // 文件在最早那天开始前就没再动过，不可能有这几天的消息
    if (s.fileMtimeMs && s.fileMtimeMs < earliest) continue;
    if (++n % 20 === 0) await new Promise((r) => setImmediate(r));
    let lines = [];
    try { lines = fs.readFileSync(s.file, 'utf8').split('\n') } catch { continue }
    const perDay = new Map();
    for (const line of lines) {
      if (!line.includes('"message"')) continue;
      let e;
      try { e = JSON.parse(line) } catch { continue }
      const role = e?.message?.role;
      if (e?.type !== 'message' || (role !== 'user' && role !== 'assistant')) continue;
      const ts = e.timestamp || e.message.timestamp;
      const date = ts ? localDate(ts) : '';
      if (!want.has(date)) continue;
      let text = messageText(e.message.content).replace(/\s+/g, ' ').trim();
      if (role === 'user') text = userSaid(text);
      if (text.length < 2) continue;
      if (!perDay.has(date)) perDay.set(date, []);
      perDay.get(date).push({ role, text, ts });
    }
    for (const [date, items] of perDay) byDate.get(date).push({ sid: s.id, name: s.name || s.id, items });
  }
  return byDate;
}

export async function collectDayMessages(sessions = [], date) {
  return (await collectDays(sessions, [date])).get(date);
}

/** 给模型的素材：每条截短，总长封顶 */
function digestSource(groups, maxChars = 3500) {
  const out = [];
  let used = 0;
  for (const g of groups) {
    const head = `【${g.name}】`;
    out.push(head); used += head.length;
    for (const it of g.items) {
      const line = `${it.role === 'user' ? '用户' : '她'}：${it.text.slice(0, 100)}`;
      if (used + line.length > maxChars) return out.join('\n');
      out.push(line); used += line.length;
    }
  }
  return out.join('\n');
}

/** 规则版摘要：每个会话列前三句用户原话 */
export function fallbackDigest(groups) {
  return groups.map((g) => {
    const said = g.items.filter((i) => i.role === 'user').slice(0, 3).map((i) => `「${i.text.slice(0, 60)}」`);
    return `- ${g.name}（${g.items.length} 条）${said.length ? '：' + said.join(' ') : ''}`;
  }).join('\n');
}

export async function writeDayDigest(wsRoot, { date, sessions = [], summarize = null, force = false, groups = null } = {}) {
  const target = digestPath(wsRoot, date);
  if (fs.existsSync(target) && !force) return { ok: true, skipped: true, date, reason: 'exists' };
  groups = groups || await collectDayMessages(sessions, date);
  if (!groups.length) return { ok: true, skipped: true, date, reason: 'no_data' };
  let body = '';
  if (typeof summarize === 'function') {
    try { body = String((await summarize(digestSource(groups), { date })) || '').trim() } catch { body = '' }
  }
  const fallback = !body;
  if (fallback) body = fallbackDigest(groups);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  const md = `# ${date} · 每日摘要\n\n${body}\n\n> 来源：${groups.length} 个会话，${count} 条消息（${fallback ? '规则摘要' : '模型摘要'}）\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, md, 'utf8');
  return { ok: true, skipped: false, date, fallback, sessions: groups.length, messages: count };
}

// 没消息的日子不落盘；记在内存里，免得每 30 分钟把几百个会话重扫一遍
const _noData = new Set();
// 规则版是模型失败时的兜底：之后的定时任务再试模型升级，每个日子每次启动最多试 3 次（模型一直挂着就别反复扫盘）
const MAX_MODEL_ATTEMPTS = 3;
const _attempts = new Map();

function needsWrite(wsRoot, date, canSummarize) {
  const key = `${wsRoot}|${date}`;
  if (_noData.has(key)) return false;
  let text = '';
  try { text = fs.readFileSync(digestPath(wsRoot, date), 'utf8') } catch { return true }
  return canSummarize && text.includes('（规则摘要）') && (_attempts.get(key) || 0) < MAX_MODEL_ATTEMPTS;
}

/** 补写过去 backfill 天里缺的摘要（不写今天：今天还没过完）；缺的日子一次扫完 */
export async function maybeWriteDigests(wsRoot, { now = new Date(), sessions = [], summarize = null, backfill = 7 } = {}) {
  const canSummarize = typeof summarize === 'function';
  const missing = [];
  for (let i = 1; i <= backfill; i++) {
    const date = localDate(now.getTime() - i * DAY_MS);
    if (needsWrite(wsRoot, date, canSummarize)) missing.push(date);
  }
  if (!missing.length) return [];
  const byDate = await collectDays(sessions, missing);
  const out = [];
  for (const date of missing) {
    const key = `${wsRoot}|${date}`;
    if (canSummarize) _attempts.set(key, (_attempts.get(key) || 0) + 1);
    const r = await writeDayDigest(wsRoot, { date, summarize, groups: byDate.get(date), force: true });
    if (r.reason === 'no_data') _noData.add(key);
    if (!r.skipped) out.push(r);
  }
  return out;
}

/** 从一句话里认出指的哪几天（YYYY-MM-DD，去重）；没年份的日期若在未来，算去年 */
export function parseDayRefs(text = '', now = new Date()) {
  const found = [];
  let s = String(text || '');
  const add = (y, m, d) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    if (!found.includes(iso)) found.push(iso);
  };
  const withYear = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/g;
  s = s.replace(withYear, (_, y, m, d) => { add(+y, +m, +d); return ' ' });
  const noYear = /(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]|(?<![\d-])(\d{2})-(\d{2})(?![\d-])/g;
  s.replace(noYear, (_, m1, d1, m2, d2) => {
    const m = +(m1 || m2), d = +(d1 || d2);
    let y = now.getFullYear();
    if (new Date(y, m - 1, d).getTime() > now.getTime()) y -= 1;
    add(y, m, d);
    return ' ';
  });
  const rel = [[/大前天/, 3], [/(?<!大)前天/, 2], [/昨天|昨日|昨晚/, 1]];
  for (const [re, back] of rel) if (re.test(s)) found.push(localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)));
  return [...new Set(found)];
}

/** 本轮记忆段用：提到的日子有摘要就给出（最多 3 天，每天封顶 800 字） */
export function dayDigestNote(wsRoot, message = '', now = new Date()) {
  const parts = [];
  for (const date of parseDayRefs(message, now).slice(0, 3)) {
    let text = '';
    try { text = fs.readFileSync(digestPath(wsRoot, date), 'utf8') } catch { continue }
    const body = text.replace(/^# .*\n+/, '').trim().slice(0, 800);
    if (body) parts.push(`【${date} 那天的对话摘要】\n${body}`);
  }
  return parts.join('\n\n');
}
