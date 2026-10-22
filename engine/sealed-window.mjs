// engine/sealed-window.mjs —— 封存窗口评测（2026-10-22）
//
// 来由：Quant-Arena 的评测方法 —— 研究只用旧窗口，提交固定策略，在**封存的未来窗口**
// 只测一次，并且跟基准比。我们原来的 harness-probe 是历史回放，同一批数据反复用，容易自欺。
//
// 这里的落地方式（不假装能跑模型、只做能落地的部分）：
//   · 每次"改动被采纳"时 openSealed()：记下时间点、基准成功率、窗口截止；
//   · 窗口内的真实运行只用于**评测**，不参与 propose/probe 的决策（不做调参依据）；
//   · evaluateSealed() 在窗口满（或样本≥3）时算一次成功率，给出 better/no_worse/worse，
//     写入 工程/经验库/封存评测.md，并把这条记录标成 evaluated（一个窗口只评一次）。
import fs from 'node:fs';
import path from 'node:path';

export const SEALED_FILE = '工程/经验库/封存窗口.json';
export const SEALED_REPORT = '工程/经验库/封存评测.md';
const MIN_SAMPLES = 3;

const fileOf = (wsRoot) => path.join(wsRoot, SEALED_FILE);

function readAll(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsRoot), 'utf8'));
    return Array.isArray(raw?.windows) ? raw : { windows: [] };
  } catch { return { windows: [] } }
}

function writeAll(wsRoot, data) {
  const file = fileOf(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/** 从任务的运行历史算某段区间的成功率 */
export function rateInWindow(runs = [], from, to) {
  const rows = runs.filter((r) => {
    const at = typeof r.startedAt === 'number' ? r.startedAt : Date.parse(String(r.startedAt || ''));
    return Number.isFinite(at) && at >= from && at <= to;
  });
  if (!rows.length) return { samples: 0, ok: 0, rate: null };
  const ok = rows.filter((r) => /ok|success|done/i.test(String(r.status || ''))).length;
  return { samples: rows.length, ok, rate: ok / rows.length };
}

/**
 * 开一个封存窗口。基准取"开窗前最近 3 次"的成功率，窗口内不再用这些数据调参。
 * @param {object} opts { taskId, label, change, days }
 */
export function openSealed(wsRoot, { taskId = '', label = '', change = '', days = 7, now = Date.now(), baseline = null } = {}) {
  const data = readAll(wsRoot);
  // 同一任务已有未评测窗口 → 不重复开
  const active = data.windows.find((w) => !w.evaluatedAt && w.taskId === taskId);
  if (active) return { ok: false, reason: 'active-exists', active };
  const win = {
    id: `w_${now.toString(36)}`,
    taskId,
    label,
    change: String(change || '').slice(0, 200),
    from: now,
    to: now + days * 24 * 3600_000,
    days,
    baseline,
    createdAt: new Date(now).toISOString(),
    evaluatedAt: null,
  };
  data.windows.push(win);
  writeAll(wsRoot, data);
  return { ok: true, window: win };
}

/** 当前仍在封存中的窗口（propose/probe 应当避开它们） */
export function activeWindows(wsRoot, now = Date.now()) {
  return readAll(wsRoot).windows.filter((w) => !w.evaluatedAt && w.to > now);
}

/** 把窗口内的运行排除掉：给 probe/propose 用，保证"调参数据"与"评测数据"分开 */
export function excludeSealed(runs = [], windows = []) {
  if (!windows.length) return runs;
  return runs.filter((r) => {
    const at = typeof r.startedAt === 'number' ? r.startedAt : Date.parse(String(r.startedAt || ''));
    if (!Number.isFinite(at)) return true;
    return !windows.some((w) => at >= w.from && at <= w.to);
  });
}

/** 评测一个已到期的窗口：只评一次，结论写入报告 */
export function evaluateSealed(wsRoot, { runsByTask = {}, now = Date.now() } = {}) {
  const data = readAll(wsRoot);
  const done = [];
  for (const w of data.windows) {
    if (w.evaluatedAt) continue;
    const runs = runsByTask[w.taskId] || [];
    const sealed = rateInWindow(runs, w.from, w.to);
    if (sealed.samples < MIN_SAMPLES) {
      if (now < w.to) continue;            // 还没到期，等
      // 到期但样本不足：如实记"证据不足"，不再等
      w.evaluatedAt = new Date(now).toISOString();
      w.verdict = 'insufficient';
      w.sealed = sealed;
      done.push(w);
      continue;
    }
    const base = w.baseline || {};
    let verdict = 'no_worse';
    if (Number.isFinite(base.rate) && Number.isFinite(sealed.rate)) {
      if (sealed.rate >= base.rate + 0.1) verdict = 'better';
      else if (sealed.rate <= base.rate - 0.1) verdict = 'worse';
    }
    w.evaluatedAt = new Date(now).toISOString();
    w.verdict = verdict;
    w.sealed = sealed;
    done.push(w);
  }
  if (done.length) {
    writeAll(wsRoot, data);
    appendReport(wsRoot, done);
  }
  return { ok: true, evaluated: done };
}

const VERDICT_TEXT = { better: '✅ 更好', no_worse: '➖ 不更差', worse: '⚠️ 更差', insufficient: '❔ 证据不足' };

export function appendReport(wsRoot, windows) {
  try {
    const file = path.join(wsRoot, SEALED_REPORT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '# 封存窗口评测（自动生成）\n\n> 由 sealed-window 写入：窗口内的真实运行只用于评测，不参与调参。\n\n', 'utf8');
    }
    const lines = windows.map((w) => {
      const base = Number.isFinite(w.baseline?.rate) ? `${Math.round(w.baseline.rate * 100)}%` : '—';
      const got = Number.isFinite(w.sealed?.rate) ? `${Math.round(w.sealed.rate * 100)}%（${w.sealed.ok}/${w.sealed.samples}）` : '样本不足';
      return `- ${w.evaluatedAt} · ${w.label || w.taskId || '任务'} · ${VERDICT_TEXT[w.verdict] || w.verdict} · 基准 ${base} → 封存窗 ${got}${w.change ? ` · 改动：${String(w.change).slice(0, 80)}` : ''}`;
    }).join('\n');
    fs.appendFileSync(file, lines + '\n', 'utf8');
  } catch {}
}

/** 给晨报/接口看的摘要 */
export function sealedSummary(wsRoot, now = Date.now()) {
  const data = readAll(wsRoot);
  const active = data.windows.filter((w) => !w.evaluatedAt && w.to > now);
  const done = data.windows.filter((w) => w.evaluatedAt);
  return {
    active: active.length,
    done: done.length,
    nextDueDays: active.length ? Math.max(0, Math.ceil((Math.min(...active.map((w) => w.to)) - now) / 86400_000)) : null,
    lastVerdict: done.length ? done[done.length - 1].verdict : '',
  };
}
