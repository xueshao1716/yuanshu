// engine/usage-summary.mjs —— 单会话用量与速度（2026-10-24）
//
// 对标 DSH 状态栏那三个数字：tok/s、缓存命中率、上下文占用。
// 数据来源只有一个——会话 JSONL 里 assistant 消息自带的 usage（provider 真实返回），
// 不估算、不造数：没有 usage 的轮次不计入。
import fs from 'node:fs';

function parseUsage(entry) {
  const u = entry?.message?.usage;
  if (!u) return null;
  const input = Number(u.input) || 0;
  const output = Number(u.output) || 0;
  const cacheRead = Number(u.cacheRead) || 0;
  const cacheWrite = Number(u.cacheWrite) || 0;
  const total = Number(u.totalTokens) || input + output + cacheRead + cacheWrite;
  if (!input && !output && !cacheRead && !total) return null;
  let cost = u.cost;
  if (cost && typeof cost === 'object') cost = cost.total || cost.input || 0;
  return { input, output, cacheRead, cacheWrite, total, cost: typeof cost === 'number' ? cost : 0, ts: entry.timestamp || null };
}

export function sessionUsageSummary(file, { contextWindow = 0 } = {}) {
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean);
  } catch { return null }

  const turns = [];
  for (const e of rows) {
    if (e?.type !== 'message' || e?.message?.role !== 'assistant') continue;
    const u = parseUsage(e);
    if (u) turns.push(u);
  }
  if (!turns.length) {
    return { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, cacheHitRate: null, tps: null, contextTokens: 0, contextPct: null };
  }

  const sum = (k) => turns.reduce((a, t) => a + t[k], 0);
  const input = sum('input'), output = sum('output'), cacheRead = sum('cacheRead'), cacheWrite = sum('cacheWrite'), cost = sum('cost');

  // 缓存命中率：读缓存占「输入侧」的比例（行业惯例口径）
  const inputSide = input + cacheRead;
  const cacheHitRate = inputSide > 0 ? cacheRead / inputSide : null;

  // tok/s：逐轮用「该轮输出 token / 与上一轮的时间差」算，再取中位数——
  // 不用总和/总时长：中间可能有几十分钟的闲置，会把速度稀释成假的。
  const perTurn = [];
  for (let i = 1; i < turns.length; i++) {
    const prev = Date.parse(turns[i - 1].ts || '');
    const cur = Date.parse(turns[i].ts || '');
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    const sec = (cur - prev) / 1000;
    if (sec <= 0.5 || sec > 1800) continue;      // 太快像同一条，太慢多半是闲置
    const tok = turns[i].output || 0;
    if (tok < 5) continue;
    perTurn.push(tok / sec);
  }
  perTurn.sort((a, b) => a - b);
  const tps = perTurn.length ? Math.round(perTurn[Math.floor(perTurn.length / 2)]) : null;

  const last = turns[turns.length - 1];
  const contextTokens = last.total || last.input + last.cacheRead + last.output;
  const contextPct = contextWindow > 0 ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : null;

  return { messages: turns.length, input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite, cost, cacheHitRate, tps, contextTokens, contextPct };
}
