// engine/token-budget.mjs —— 每日 token 预算（2026-10-24）
//
// 起因：DeepSeek 官网余额掉得快，但元枢账本此前看不到自己循环的花费（usage 被丢弃，已修）。
// 现在每轮 usage 都记进 记忆/运行时/每轮耗时.jsonl，这里按天汇总，超预算就降级/提示，
// 而不是等到充值才发现。
//
// 预算文件：记忆/运行时/token预算.json
//   { "dailyTokens": 3000000, "hardMultiplier": 2, "enabled": true }
//   默认 300 万 token/天；超过 hardMultiplier 倍视为"硬超"。
import fs from 'node:fs';
import path from 'node:path';

const BUDGET_FILE = ['记忆', '运行时', 'token预算.json'];
const PROFILE_FILE = ['记忆', '运行时', '每轮耗时.jsonl'];
const DEFAULTS = { dailyTokens: 3_000_000, hardMultiplier: 2, enabled: true };

export function readBudget(wsRoot) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(wsRoot, ...BUDGET_FILE), 'utf8'));
    return {
      enabled: j.enabled !== false,
      dailyTokens: Math.max(100_000, Number(j.dailyTokens) || DEFAULTS.dailyTokens),
      hardMultiplier: Math.max(1.2, Number(j.hardMultiplier) || DEFAULTS.hardMultiplier),
      // 2026-10-25：过预算时是否自动换更便宜的模型（默认开）。设 false 就只提示、不换。
      downgrade: j.downgrade !== false,
    };
  } catch {
    return { ...DEFAULTS, downgrade: true };
  }
}

const localDate = (t) => new Date(t).toLocaleDateString('sv-SE');

/** 今天（本地时区）已用 token，按 provider 拆开 */
export function todayUsage(wsRoot, now = new Date()) {
  const day = localDate(now);
  const per = {};
  let total = 0;
  let measured = 0;
  const file = path.join(wsRoot, ...PROFILE_FILE);
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-8000) } catch { return { day, total: 0, measured: 0, per } }
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line) } catch { continue }
    if (!r?.usage || !r.usage.calls) continue;
    if (localDate(r.at || r.ts || 0) !== day) continue;
    const u = r.usage;
    const tokens = (Number(u.input) || 0) + (Number(u.output) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
    if (!tokens) continue;
    const prov = String(r.model?.provider || r.provider || 'unknown');
    per[prov] = per[prov] || { tokens: 0, calls: 0, input: 0, output: 0, cacheRead: 0 };
    per[prov].tokens += tokens;
    per[prov].calls += Number(u.calls) || 1;
    per[prov].input += Number(u.input) || 0;
    per[prov].output += Number(u.output) || 0;
    per[prov].cacheRead += Number(u.cacheRead) || 0;
    total += tokens;
    measured += 1;
  }
  return { day, total, measured, per };
}

/** 预算判定：ok / warn（过线）/ hard（过 2 倍） */
export function checkBudget(wsRoot, now = new Date()) {
  const budget = readBudget(wsRoot);
  const usage = todayUsage(wsRoot, now);
  const ratio = budget.dailyTokens > 0 ? usage.total / budget.dailyTokens : 0;
  let level = 'ok';
  if (budget.enabled) {
    if (ratio >= budget.hardMultiplier) level = 'hard';
    else if (ratio >= 1) level = 'warn';
  }
  return {
    ...usage,
    budget,
    ratio: Math.round(ratio * 1000) / 1000,
    level,
    hint: level === 'hard'
      ? '今日 token 已超预算两倍：建议只做必要的事，或换更便宜的模型，或明天再说'
      : level === 'warn'
        ? '今日 token 已过预算：能交给 deepseek-flash 做的就别用贵模型'
        : '',
  };
}
