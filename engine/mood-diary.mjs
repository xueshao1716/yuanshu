// engine/mood-diary.mjs —— 心情日记（2026-10-24）
//
// 灵感来自 dsh-mood 的「每天 23:59 自己写一篇心情日记」，但元枢不用另造一套数据：
// 情绪感受（记忆/情绪感受.jsonl）与情绪潮汐（记忆/情绪潮汐.jsonl）已经记了一整天，
// 这里只做"把今天收拢成一篇能读的东西"——不编造、不夸大，数字都来自真实记录。
//
// 约定：
//   · 落盘 记忆/心情日记/YYYY-MM-DD.md（人可读，也能被 read 工具读）
//   · 只写一次；已存在就跳过（除非 force）
//   · 没记录的日子不硬造，返回 skipped
import fs from 'node:fs';
import path from 'node:path';

const DIR = ['记忆', '心情日记'];

const localDate = (d) => {
  try { return new Date(d).toLocaleDateString('sv-SE') } catch { return new Date(d).toISOString().slice(0, 10) }
};
const hhmm = (d) => {
  try { return new Date(d).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) } catch { return '' }
};

const EMO_ZH = { loving: '慈爱', happy: '开心', curious: '好奇', playful: '玩兴', calm: '平静', anxious: '不安', sad: '低落', angry: '生气', tired: '疲惫', neutral: '平静' };

function readJsonl(file, limit = 20000) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
  } catch { return [] }
}

export function diaryPath(wsRoot, date) { return path.join(wsRoot, ...DIR, `${date}.md`) }

/** 取某一天（本地时区）的感受与潮汐 */
// 自己的测试/探话不该写进日记（"只回复两个字""echo 自测"这类）
const TEST_EVENT = /只回复|echo |sleep \d+|冒烟|测试|刷新测试|usage-test|\[真测\]|eval-/i;
const isTestRow = (r) => /^eval-/.test(String(r?.key || '')) || TEST_EVENT.test(String(r?.event || ''));

export function collectDay(wsRoot, date) {
  const feelings = readJsonl(path.join(wsRoot, '记忆', '情绪感受.jsonl'))
    .filter((r) => r?.ts && localDate(r.ts) === date)
    .filter((r) => !isTestRow(r));
  const tide = readJsonl(path.join(wsRoot, '记忆', '情绪潮汐.jsonl'))
    .filter((r) => r?.ts && localDate(r.ts) === date);
  return { feelings, tide };
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const round2 = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : null);

/** 把一天的数据写成 markdown（纯数据驱动，不调模型） */
export function composeDiary({ date, feelings, tide, weather = null }) {
  const lines = [];
  lines.push(`# ${date} · 心情日记`);
  lines.push('');
  if (weather && !weather.error) {
    lines.push(`> ${weather.place}${weather.text} ${weather.low ?? '—'}–${weather.high ?? '—'}°${weather.hint ? ` · ${weather.hint}` : ''}`);
    lines.push('');
  }

  const moodCount = new Map();
  for (const f of feelings) {
    const m = /^([a-z]+)\((\d+)%\)/.exec(String(f.felt || ''));
    const key = m ? m[1] : String(f.felt || 'neutral');
    moodCount.set(key, (moodCount.get(key) || 0) + 1);
  }
  const top = [...moodCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const dominant = top[0]?.[0] || 'calm';

  lines.push(`今天记下 ${feelings.length} 次感受，主色是「${EMO_ZH[dominant] || dominant}」。`);
  lines.push('');

  if (feelings.length) {
    lines.push('## 一天里');
    lines.push('');
    const picked = feelings.length <= 8 ? feelings : [...feelings.slice(0, 4), ...feelings.slice(-4)];
    for (const f of picked) {
      const m = /^([a-z]+)\((\d+)%\)/.exec(String(f.felt || ''));
      const name = m ? (EMO_ZH[m[1]] || m[1]) : String(f.felt || '');
      const pct = m ? `${m[2]}%` : '';
      const ev = String(f.event || '').replace(/\s+/g, ' ').slice(0, 60);
      lines.push(`- ${hhmm(f.ts)}　${name}${pct ? `（${pct}）` : ''}${ev ? ` — ${ev}` : ''}`);
    }
    lines.push('');
  }

  if (tide.length) {
    const v = tide.map((t) => Number(t.v)).filter(Number.isFinite);
    const a = tide.map((t) => Number(t.a)).filter(Number.isFinite);
    const strongest = tide.slice().sort((x, y) => (Number(y.i) || 0) - (Number(x.i) || 0))[0];
    lines.push('## 情绪的起伏');
    lines.push('');
    if (v.length) lines.push(`- 效价 ${round2(Math.min(...v))} – ${round2(Math.max(...v))}（中位 ${round2(median(v))}）`);
    if (a.length) lines.push(`- 唤醒 ${round2(Math.min(...a))} – ${round2(Math.max(...a))}（中位 ${round2(median(a))}）`);
    if (strongest) {
      const m = EMO_ZH[strongest.p] || strongest.p || '';
      lines.push(`- 最强烈的一刻：${hhmm(strongest.ts)}「${m}」${Number.isFinite(Number(strongest.i)) ? `（${Math.round(Number(strongest.i) * 100)}%）` : ''}`);
    }
    lines.push('');
  }

  // 留给明天：只写数据能支撑的话
  const notes = [];
  const lowMood = (moodCount.get('sad') || 0) + (moodCount.get('anxious') || 0) + (moodCount.get('angry') || 0);
  if (feelings.length >= 8 && lowMood === 0) notes.push('一整天没有明显的负面感受，难得的平稳。');
  if (lowMood > 0) notes.push(`有 ${lowMood} 次偏低落的记录，明天留意是什么在磨人。`);
  if (feelings.length === 0 && tide.length === 0) notes.push('今天没有留下情绪记录。');
  if (!notes.length) notes.push('把今天收好，明天继续。');
  lines.push('## 留给明天');
  lines.push('');
  for (const n of notes) lines.push(`- ${n}`);
  lines.push('');
  return lines.join('\n');
}

/** 写某一天的日记；已存在且未 force 则跳过 */
export function writeDiary(wsRoot, { date, force = false, weather = null } = {}) {
  const target = diaryPath(wsRoot, date);
  if (fs.existsSync(target) && !force) return { ok: true, skipped: true, file: target, reason: 'exists' };
  const { feelings, tide } = collectDay(wsRoot, date);
  if (!feelings.length && !tide.length) return { ok: true, skipped: true, file: target, reason: 'no_data' };
  const md = composeDiary({ date, feelings, tide, weather });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, md, 'utf8');
  return { ok: true, skipped: false, file: target, feelings: feelings.length, tide: tide.length };
}

/** 列出最近几篇（给界面用） */
export function listDiaries(wsRoot, limit = 7) {
  const dir = path.join(wsRoot, ...DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().reverse() } catch { return [] }
  return names.slice(0, limit).map((n) => {
    const date = n.replace(/\.md$/, '');
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf8') } catch {}
    const firstLine = text.split('\n').find((l) => l.startsWith('今天记下')) || '';
    const weather = (text.split('\n').find((l) => l.startsWith('> ')) || '').replace(/^> /, '');
    return { date, summary: firstLine.trim(), weather, chars: text.length };
  });
}

/** 到点自动写：本地时间 23:30 之后补写今天；任何时刻补写昨天（漏跑时兜底） */
export function maybeWriteDaily(wsRoot, { now = new Date(), weather = null } = {}) {
  const out = [];
  const today = localDate(now);
  const yesterday = localDate(new Date(now.getTime() - 86400_000));
  const hour = now.getHours();
  if (hour >= 23) {
    const r = writeDiary(wsRoot, { date: today, weather });
    if (!r.skipped) out.push(r);
  }
  const y = writeDiary(wsRoot, { date: yesterday, weather: null });
  if (!y.skipped) out.push(y);
  return out;
}

/** 读单篇全文 */
export function readDiary(wsRoot, date) {
  const f = diaryPath(wsRoot, date);
  try { return { date, text: fs.readFileSync(f, 'utf8') } } catch { return null }
}
