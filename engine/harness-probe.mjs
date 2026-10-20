// engine/harness-probe.mjs —— 改了之后到底有没有变好（2026-10-20）
//
// 来源：Google Harness²（arXiv:2610.14224）的 Propose–Probe–Compose。
// 它最有价值的一点是：开放世界里没有标准答案，也能判断改动好坏——**比执行轨迹，不比答案**。
//
// 我们的现状：夜里反思写经验、写技能，写完就生效，没有任何对照。
// 这里补上 Probe 这一步。取样方式刻意保守：
//   · 不重跑任务（省钱、省时，也不打扰主人）；
//   · 用同一条定时任务的**历史运行**做自然实验：改动前 3 次 vs 改动后 3 次；
//   · 只比客观计数（失败次数、耗时、工具调用数），**不让模型自评"我觉得更好了"**。
// 证据不足就如实说"样本不足"，不硬给结论。
//
// 边界：本模块只读历史 + 写一条试验记录，不改任何 harness。采纳与否由人（或自主执行通道）决定。
import fs from 'node:fs';
import path from 'node:path';

export const PROBE_LOG_FILE = '文档/harness-试验.md';
export const PROBE_LESSON_FILE = '工程/经验库/harness-lessons.md';
export const MIN_SAMPLES = 3;   // 每侧最少样本
export const MAX_SAMPLES = 6;   // 每侧最多取几次

export function probeLogPath(wsRoot) { return path.join(wsRoot, PROBE_LOG_FILE); }

// 从时间引擎的 history 里取可比的指标。history 每项：{queueId, startedAt, durationMs, status, result}
export function traceMetrics(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && Number.isFinite(Number(r.durationMs)));
  const runs = list.length;
  if (!runs) return { runs: 0, failures: 0, failRate: 0, avgMs: 0, p90Ms: 0 };
  const durations = list.map(r => Number(r.durationMs)).sort((a, b) => a - b);
  const failures = list.filter(r => r.status === 'error' || r.ok === false).length;
  const avgMs = Math.round(durations.reduce((a, b) => a + b, 0) / runs);
  const p90Ms = durations[Math.min(runs - 1, Math.floor(runs * 0.9))];
  return { runs, failures, failRate: Math.round((failures / runs) * 100) / 100, avgMs, p90Ms };
}

// 把历史切成"改动前 / 改动后"。history 按时间正序（旧→新）。
export function splitBeforeAfter(history = [], { changeAt = null, perSide = MIN_SAMPLES } = {}) {
  const raw = (Array.isArray(history) ? history : []).filter(r => r && Number.isFinite(Number(r.durationMs)));
  // 时间引擎的 history 用 unshift 存，**新的在前**；这里统一按 startedAt 升序（旧→新）再切。
  const list = raw.slice().sort((x, y) => String(x.startedAt || '').localeCompare(String(y.startedAt || '')));
  const n = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, perSide));
  if (changeAt) {
    const idx = list.findIndex(r => String(r.startedAt || '') >= String(changeAt));
    if (idx < 0) return { before: list.slice(-n), after: [] };
    return { before: list.slice(Math.max(0, idx - n), idx), after: list.slice(idx, idx + n) };
  }
  if (list.length < n * 2) return { before: list.slice(0, Math.floor(list.length / 2)), after: list.slice(Math.floor(list.length / 2)) };
  return { before: list.slice(-n * 2, -n), after: list.slice(-n) };
}

// 客观判定：失败率不升、耗时不显著变慢 = 通过；变慢/更多失败 = 该回退
export function abCompare(beforeRows = [], afterRows = []) {
  const a = traceMetrics(beforeRows), b = traceMetrics(afterRows);
  if (a.runs < MIN_SAMPLES || b.runs < MIN_SAMPLES) {
    return { verdict: 'insufficient', a, b,
      reason: `样本不足（前 ${a.runs} 次 / 后 ${b.runs} 次，各需 ≥${MIN_SAMPLES}）` };
  }
  const slower = b.avgMs > a.avgMs * 1.25 && b.avgMs - a.avgMs > 5000;
  const worseFails = b.failRate > a.failRate;
  const faster = a.avgMs > b.avgMs * 1.25 && a.avgMs - b.avgMs > 5000;
  const fewerFails = b.failRate < a.failRate;
  const deltas = { avgMs: b.avgMs - a.avgMs, avgPct: a.avgMs ? Math.round(((b.avgMs - a.avgMs) / a.avgMs) * 100) : 0,
    failRate: Math.round((b.failRate - a.failRate) * 100) / 100 };
  if (worseFails || slower) {
    return { verdict: 'worse', a, b, deltas,
      reason: [worseFails ? `失败率 ${a.failRate}→${b.failRate}` : '', slower ? `平均耗时 ${a.avgMs}→${b.avgMs}ms` : ''].filter(Boolean).join('；') };
  }
  if (fewerFails || faster) {
    return { verdict: 'better', a, b, deltas,
      reason: [fewerFails ? `失败率 ${a.failRate}→${b.failRate}` : '', faster ? `平均耗时 ${a.avgMs}→${b.avgMs}ms` : ''].filter(Boolean).join('；') };
  }
  return { verdict: 'no_worse', a, b, deltas, reason: '指标没有恶化，也没有明显改善' };
}

const VERDICT_TEXT = {
  better: '✅ 变好了',
  no_worse: '➖ 没变差（也没明显变好）',
  worse: '⚠️ 变差了，建议回退',
  insufficient: '· 样本不足，不下结论',
};

export function renderProbeRow(row) {
  const v = VERDICT_TEXT[row.verdict] || row.verdict;
  return `- ${row.at} · ${row.task || '定时任务'} · ${v} · 前 ${row.a?.runs ?? 0} 次 vs 后 ${row.b?.runs ?? 0} 次` +
    `${row.reason ? ` · ${row.reason}` : ''}${row.change ? ` · 改动：${String(row.change).slice(0, 120)}` : ''}`;
}

// 结论 → 经验：变差就写"该回退"，变好就写"可保留"，中性只记录不推广。只写可执行的一句话。
export function appendLesson(wsRoot, row, { fsMod = fs } = {}) {
  try {
    const target = path.join(wsRoot, PROBE_LESSON_FILE);
    fsMod.mkdirSync(path.dirname(target), { recursive: true });
    if (!fsMod.existsSync(target)) {
      fsMod.writeFileSync(target,
        '# Harness 试验结论（自动生成）\n\n> 由 harness-probe 写入：每次改动后的前后对照，只留可执行结论。人工经验请写 experience.md。\n\n', 'utf8');
    }
    const at = String(row.at || new Date().toISOString()).slice(0, 19).replace('T', ' ');
    const head = row.verdict === 'worse' ? '⚠️ 该回退' : row.verdict === 'better' ? '✅ 可保留' : '➖ 中性';
    const detail = row.reason ? `（${row.reason}）` : '';
    const action = row.verdict === 'worse'
      ? '回退到改动前的版本，别在这个方向继续叠改动。'
      : row.verdict === 'better'
      ? '保留，并在同类任务里作为默认做法。'
      : '保留但不推广——没有证据说明它更好。';
    fsMod.appendFileSync(target, `- ${at} · ${row.task || '定时任务'} · ${head}${detail} · ${action}\n`, 'utf8');
    return true;
  } catch { return false }
}

export function appendProbeLog(wsRoot, row, { fsMod = fs } = {}) {
  try {
    const target = probeLogPath(wsRoot);
    fsMod.mkdirSync(path.dirname(target), { recursive: true });
    if (!fsMod.existsSync(target)) {
      fsMod.writeFileSync(target,
        '# Harness 试验记录\n\n> 每次改动后，用同一条任务的历史运行做前后对照（只比失败率与耗时，不让模型自评）。\n> 变差的就是该回退的；样本不足就明说，不硬下结论。\n\n', 'utf8');
    }
    fsMod.appendFileSync(target, renderProbeRow(row) + '\n', 'utf8');
    return true;
  } catch { return false }
}

// 节流：同一任务每天最多做一次对照，免得每次跑完都往日志里写一遍
export const PROBE_MARK_FILE = '记忆/运行时/harness-试验.json';
export function shouldProbe(wsRoot, taskId, { now = new Date(), fsMod = fs } = {}) {
  try {
    const day = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
    const file = path.join(wsRoot, PROBE_MARK_FILE);
    const marks = fsMod.existsSync(file) ? JSON.parse(fsMod.readFileSync(file, 'utf8')) : {};
    return marks[String(taskId)] !== day;
  } catch { return true }
}
export function markProbed(wsRoot, taskId, { now = new Date(), fsMod = fs } = {}) {
  try {
    const day = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
    const file = path.join(wsRoot, PROBE_MARK_FILE);
    fsMod.mkdirSync(path.dirname(file), { recursive: true });
    const marks = fsMod.existsSync(file) ? JSON.parse(fsMod.readFileSync(file, 'utf8')) : {};
    marks[String(taskId)] = day;
    fsMod.writeFileSync(file, JSON.stringify(marks, null, 2), 'utf8');
    return true;
  } catch { return false }
}

// 给上游用：把最近几次试验压成一句话（进自我描述 / 夜间复盘）
export function summarizeProbeLog(wsRoot, { limit = 3, fsMod = fs } = {}) {
  try {
    const rows = fsMod.readFileSync(probeLogPath(wsRoot), 'utf8').split('\n').filter(l => l.startsWith('- '));
    if (!rows.length) return '';
    const tail = rows.slice(-limit).map(l => l.replace(/^-\s*/, ''));
    const bad = tail.filter(l => l.includes('变差')).length;
    return `最近 ${tail.length} 次 harness 试验：${bad ? `${bad} 次变差（该回退）` : '没有变差的'}；明细见 ${PROBE_LOG_FILE}`;
  } catch { return '' }
}
