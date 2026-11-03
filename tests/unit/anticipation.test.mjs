// 预判：期望损失 vs 打扰成本（2026-11-03）
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHistory, estimateAction, replay } from "../../engine/anticipation.mjs";

const now = Date.parse("2026-11-03T18:00:00");
const at = (h) => new Date(now - h * 3600000).toISOString();
const ev = (verdict, o = {}) => ({ kind: "gate", taskType: "coding", at: at(1), verdict, ...o });

test("历史：按类型算失败率", () => {
  const events = [ev("pass"), ev("pass"), ev("red"), ev("red")];
  const h = buildHistory(events, { now });
  assert.equal(h[0].total, 4);
  assert.equal(h[0].bad, 2);
  assert.equal(h[0].badRate, 0.5);
});

test("高风险高后果：该出手", () => {
  const history = [{ taskType: "coding", total: 10, bad: 6, badRate: 0.6, avgRework: 20 }];
  const [r] = estimateAction({ candidates: [{ id: "a", taskType: "coding" }], history, engageRate: 0.5, threshold: 2 });
  assert.equal(r.shouldAct, true);
  assert.equal(r.expectedLoss, 12);
  assert.match(r.reason, /大于打扰成本/);
});

test("低风险低后果：不动", () => {
  const history = [{ taskType: "ops", total: 10, bad: 1, badRate: 0.1, avgRework: 5 }];
  const [r] = estimateAction({ candidates: [{ id: "b", taskType: "ops" }], history, engageRate: 0.5, threshold: 2 });
  assert.equal(r.shouldAct, false);
  assert.equal(r.expectedLoss, 0.5);
});

test("没有历史：不出手（宁可不打扰）", () => {
  const [r] = estimateAction({ candidates: [{ id: "c", taskType: "未知" }], history: [] });
  assert.equal(r.shouldAct, false);
});

test("engageRate 高 → 打扰成本低 → 更容易出手", () => {
  const history = [{ taskType: "coding", total: 10, bad: 1, badRate: 0.1, avgRework: 10 }];
  const cand = [{ id: "d", taskType: "coding" }];
  const low = estimateAction({ candidates: cand, history, engageRate: 0.9, threshold: 2 })[0];
  const high = estimateAction({ candidates: cand, history, engageRate: 0.1, threshold: 2 })[0];
  assert.equal(low.shouldAct, true);
  assert.equal(high.shouldAct, false);
});

test("回放：输出可解释计数", () => {
  const events = [ev("red"), ev("pass"), ev("red"), ev("pass"), ev("pass")];
  const r = replay(events, { now, days: 30 });
  assert.equal(r.badEvents, 2);
  assert.equal(typeof r.wouldAct, "number");
  assert.equal(typeof r.fireRate, "number");
  assert.ok(Array.isArray(r.history));
});
