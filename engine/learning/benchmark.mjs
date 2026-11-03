// ===== benchmark.mjs —— 新旧版本对比（M2 核心，2026-11-03）=====
//
// 用封存用例做同一批考卷：旧版本 vs 新版本，比成功率与回归。
// 纪律：
//   · 必须用封存用例（≥20 条），且哈希校验通过
//   · 只要出现"新版本把旧版本能过的题做错" → 直接拒绝，不管总分涨多少
//   · 样本不够（<20）不出结论
import { canUseAsBenchmark, loadSealed } from "./sealed-cases.mjs";

const rate = (n, d) => (d > 0 ? Number((n / d).toFixed(3)) : null);

/**
 * 对比两组结果。
 * @param {{cases:Array, baseline:Array<{id:string,ok:boolean}>, candidate:Array<{id:string,ok:boolean}>, minDelta?:number}} opts
 */
export function compareResults({ cases = [], baseline = [], candidate = [], minDelta = 0.05 } = {}) {
  if (!Array.isArray(cases) || cases.length < 20) {
    return { ok: false, reason: `封存用例不足 20 条（现在 ${cases?.length || 0}）`, verdict: "refuse" };
  }
  const byId = (rows) => new Map((Array.isArray(rows) ? rows : []).map((r) => [String(r.id), !!r.ok]));
  const b = byId(baseline);
  const c = byId(candidate);
  const ids = cases.map((x) => String(x.id)).filter((id) => b.has(id) && c.has(id));
  if (ids.length < 20) return { ok: false, reason: `可比样本不足（${ids.length} < 20）`, verdict: "refuse" };

  let bOk = 0, cOk = 0;
  const regressions = [];
  const gains = [];
  for (const id of ids) {
    const was = b.get(id), now = c.get(id);
    if (was) bOk += 1;
    if (now) cOk += 1;
    if (was && !now) regressions.push(id);
    if (!was && now) gains.push(id);
  }
  const baselineRate = rate(bOk, ids.length);
  const candidateRate = rate(cOk, ids.length);
  const delta = Number((candidateRate - baselineRate).toFixed(3));

  if (regressions.length) {
    return { ok: false, verdict: "reject", reason: `新版本把 ${regressions.length} 道旧版本能过的题做错了`, baselineRate, candidateRate, delta, regressions, gains, n: ids.length };
  }
  if (delta >= minDelta) {
    return { ok: true, verdict: "promote", reason: `成功率 ${baselineRate} → ${candidateRate}（+${delta}），无回归`, baselineRate, candidateRate, delta, regressions, gains, n: ids.length };
  }
  return { ok: false, verdict: "reject", reason: `提升不足（${baselineRate} → ${candidateRate}，需要 +${minDelta}）`, baselineRate, candidateRate, delta, regressions, gains, n: ids.length };
}

/** 结合封存用例做完整判定（先校验考卷，再比结果）。 */
export function judgeWithSealed(wsRoot, skill, { baseline = [], candidate = [], minDelta = 0.05 } = {}) {
  const bench = canUseAsBenchmark(wsRoot, skill);
  if (!bench.ok) return { ok: false, verdict: "refuse", reason: bench.reason };
  const sealed = loadSealed(wsRoot, skill);
  if (!sealed.ok) return { ok: false, verdict: "refuse", reason: sealed.error };
  return compareResults({ cases: sealed.cases, baseline, candidate, minDelta });
}
