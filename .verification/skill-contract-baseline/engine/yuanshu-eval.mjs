// 元枢独立评测绳：跑冻结用例，出 passed/total/score。不调用真模型。
import { YUANSHU_EVAL_CASES } from "./yuanshu-eval-cases.mjs";

export async function runYuanshuEval(cases = YUANSHU_EVAL_CASES) {
  const results = [];
  for (const c of cases) {
    try {
      await c.run();
      results.push({ id: c.id, tag: c.tag, ok: true });
    } catch (e) {
      results.push({ id: c.id, tag: c.tag, ok: false, detail: String(e?.message || e).slice(0, 200) });
    }
  }
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const byTag = {};
  for (const r of results) {
    const slot = byTag[r.tag] || (byTag[r.tag] = { passed: 0, total: 0 });
    slot.total += 1;
    if (r.ok) slot.passed += 1;
  }
  return {
    passed,
    total,
    failed: total - passed,
    score: total ? Number((passed / total).toFixed(4)) : 0,
    byTag,
    failures: results.filter((r) => !r.ok),
  };
}

export function formatYuanshuEval(r) {
  const pct = Math.round((Number(r?.score) || 0) * 100);
  return `元枢评测 ${r?.passed || 0}/${r?.total || 0}（${pct}%）`;
}
