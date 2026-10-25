// ===== usage-view.mjs —— 用量状态条的数据视图（2026-10-25 从 server.mjs 内联抽出）=====
//
// 为什么要抽出来：这段口径原来写在 /api/usage/session 路由里，无法单测，
// 而它恰恰是最容易被"看起来对"骗过去的地方——见下面 tok/s 的注释。
//
// 数据只有一处来源：记忆/运行时/每轮耗时.jsonl 里每一轮的 provider 真实 usage。
// 不估算、不造数：没有 usage 的轮次不计入。
import fs from 'node:fs';

/** 生成窗口短于这个值时，tok/s 测不准（事件循环会把增量攒批，算出几百上千的假速度）。 */
export const MIN_GEN_MS = 500;

export function parseUsageRecord(record) {
  const u = record?.usage;
  if (!u || !(Number(u.calls) > 0)) return null;
  const input = Number(u.input) || 0;
  const output = Number(u.output) || 0;
  const cacheRead = Number(u.cacheRead) || 0;
  const cacheWrite = Number(u.cacheWrite) || 0;
  const totalMs = Number(record.totalMs) || 0;
  const firstDeltaMs = Number.isFinite(Number(record.firstDeltaMs)) && record.firstDeltaMs != null ? Number(record.firstDeltaMs) : null;
  return { input, output, cacheRead, cacheWrite, totalMs, firstDeltaMs };
}

/**
 * tok/s 的口径：**输出 token ÷（总耗时 − 首字延迟）**，逐轮算再取中位数。
 * 注意这里单轮也能算——所以"单轮不显示"的原因从来不是"需要 ≥2 轮"，
 * 而是短窗口（<500ms）算出来的数是噪声，被门槛挡掉了。
 */
export function turnSpeed(rows = []) {
  const perTurn = [];
  const firsts = [];
  for (const r of rows) {
    const rec = parseUsageRecord(r);
    if (!rec) continue;
    if (rec.totalMs <= 0) continue;
    if (rec.firstDeltaMs != null && rec.firstDeltaMs > 0) firsts.push(rec.firstDeltaMs);
    const genMs = rec.totalMs - (rec.firstDeltaMs || 0);
    if (genMs < MIN_GEN_MS) continue;
    if (rec.output < 5) continue;
    perTurn.push({ tps: (rec.output / genMs) * 1000, at: String(r.at || '') });
  }
  const sorted = perTurn.map((x) => x.tps).sort((a, b) => a - b);
  const tps = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null;
  // 2026-10-25：中位数是「稳定值」，但它几乎不动——用户盯着同一个数字（比如 12）会以为坏了。
  // 再给一个「最近一轮」的真实速度，界面上优先显示它，中位数留作背景参考。
  const lastTps = perTurn.length ? Math.round(perTurn[perTurn.length - 1].tps) : null;
  const firstSorted = firsts.slice().sort((a, b) => a - b);
  const firstMs = firstSorted.length ? Math.round(firstSorted[Math.floor(firstSorted.length / 2)]) : null;
  return {
    tps,
    lastTps,
    // 单轮也能给数，但要标出来：样本只有 1 条时它不是"稳定速度"
    tpsKind: tps == null ? null : (perTurn.length > 1 ? 'median' : 'single'),
    tpsSamples: perTurn.length,
    firstMs,
  };
}

/** 一屏状态条需要的全部数字（路由只负责读文件 + 注入模型窗口）。 */
export function usageView(rows = [], { sessionId = '', contextWindow = 0, model = '' } = {}) {
  const own = (rows || []).filter((r) => r && (!sessionId || r.sessionId === sessionId));
  const withUsage = own.filter((r) => r.usage && Number(r.usage.calls) > 0);
  const sum = (k) => withUsage.reduce((a, r) => a + (Number(r.usage[k]) || 0), 0);
  const input = sum('input');
  const output = sum('output');
  const cacheRead = sum('cacheRead');
  const cacheWrite = sum('cacheWrite');
  const inputSide = input + cacheRead;
  const cacheHitRate = inputSide > 0 ? cacheRead / inputSide : null;
  const speed = turnSpeed(withUsage);
  const last = withUsage[withUsage.length - 1];
  const contextTokens = last ? (Number(last.usage.lastCtx) || 0) : 0;
  const contextPct = contextWindow > 0 && contextTokens > 0
    ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
    : null;
  return {
    turns: own.length,
    measured: withUsage.length,
    input, output, cacheRead, cacheWrite,
    cacheHitRate,
    tps: speed.tps,
    lastTps: speed.lastTps,
    tpsKind: speed.tpsKind,
    tpsSamples: speed.tpsSamples,
    // 单轮/短窗口时这才是用户真实感受到的数字：等了多久才开始吐字
    firstMs: speed.firstMs,
    contextTokens,
    contextWindow,
    contextPct,
    model,
  };
}

/** 读 每轮耗时.jsonl 的尾部若干行（文件会轮转，不必全读）。 */
export function readTurnProfile(file, { tail = 4000 } = {}) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-tail)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean);
  } catch { return [] }
}
