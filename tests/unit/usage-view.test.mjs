// 用量状态条的口径：tok/s 什么时候可信、单轮怎么显示、缓存与上下文怎么算。
// 抽出来的原因见 engine/usage-view.mjs 文件头——这段数最容易"看着对"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { usageView, turnSpeed, MIN_GEN_MS } from "../../engine/usage-view.mjs";

const R = ({ sessionId = "s1", totalMs = 3000, firstDeltaMs = 1000, output = 100, input = 500, cacheRead = 500, cacheWrite = 0, lastCtx = 20000, at = "2026-10-25T00:00:00.000Z" } = {}) => ({
  sessionId, at, totalMs, firstDeltaMs,
  usage: { calls: 1, input, output, cacheRead, cacheWrite, lastCtx },
});

test("tok/s：生成窗口内的速度 = 输出 ÷（总 − 首字）", () => {
  const v = turnSpeed([R({ totalMs: 3000, firstDeltaMs: 1000, output: 100 })]);
  assert.equal(v.tps, 50, "100 token / 2s = 50 tok/s");
  assert.equal(v.tpsKind, "single", "只有一轮要标成单轮");
  assert.equal(v.firstMs, 1000);
});

test("短窗口不报 tok/s（那是攒批造成的假速度），但照样给首字延迟", () => {
  // 真实样本：总 2857ms、首字 2778ms、输出 41 token → 窗口 79ms
  const v = turnSpeed([R({ totalMs: 2857, firstDeltaMs: 2778, output: 41 })]);
  assert.ok((2857 - 2778) < MIN_GEN_MS);
  assert.equal(v.tps, null, "79ms 窗口算出来是 519 tok/s，宁可不报");
  assert.equal(v.firstMs, 2778, "但首字延迟必须给出来——那才是这轮的真实体验");
});

test("多轮取中位，屏蔽单轮抖动", () => {
  const v = turnSpeed([
    R({ totalMs: 3000, firstDeltaMs: 1000, output: 100 }),   // 50
    R({ totalMs: 2000, firstDeltaMs: 1000, output: 50 }),    // 50
    R({ totalMs: 2000, firstDeltaMs: 1000, output: 500 }),   // 500 ← 抖动
  ]);
  assert.equal(v.tps, 50);
  assert.equal(v.tpsKind, "median");
  assert.equal(v.tpsSamples, 3);
});

test("没有 usage 的轮次不计入，也不猜", () => {
  const v = usageView([{ sessionId: "s1", totalMs: 3000, firstDeltaMs: 1000, usage: null }, R({})], { sessionId: "s1" });
  assert.equal(v.turns, 2, "轮次照算");
  assert.equal(v.measured, 1, "只有一条有真实 usage");
  assert.equal(v.input, 500);
  assert.equal(v.output, 100);
});

test("缓存命中率与上下文占用口径", () => {
  const v = usageView([R({ input: 500, cacheRead: 1500, lastCtx: 20000 })], { sessionId: "s1", contextWindow: 200000 });
  assert.equal(v.cacheHitRate, 0.75, "缓存读 /（输入 + 缓存读）= 1500/2000");
  assert.equal(v.contextPct, 10, "20000 / 200000");
  const noWindow = usageView([R({})], { sessionId: "s1", contextWindow: 0 });
  assert.equal(noWindow.contextPct, null, "没有模型窗口就不要编百分比");
});

test("只统计本会话的轮次（同一份 profile 里混着别的会话）", () => {
  const v = usageView([R({ sessionId: "s1", output: 100 }), R({ sessionId: "s2", output: 900 })], { sessionId: "s1" });
  assert.equal(v.turns, 1);
  assert.equal(v.output, 100, "别把别的会话的 token 算进来");
});
