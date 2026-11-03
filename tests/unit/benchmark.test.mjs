// 新老对比：无回归才晋级 / 提升不足拒绝 / 样本不足不出结论（2026-11-03）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareResults, judgeWithSealed } from "../../engine/learning/benchmark.mjs";
import { saveSealed } from "../../engine/learning/sealed-cases.mjs";

const cases = (n = 20) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, input: `in${i}`, expect: `out${i}` }));
const results = (n, okCount, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, ok: i < okCount }));

test("新版本更好且无回归 → promote", () => {
  const r = compareResults({ cases: cases(20), baseline: results(20, 14), candidate: results(20, 18) });
  assert.equal(r.verdict, "promote");
  assert.equal(r.delta, 0.2);
  assert.equal(r.regressions.length, 0);
});

test("有回归 → 直接 reject（哪怕总分涨）", () => {
  const base = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, ok: i < 14 }));
  // 新版本总体更好，但把 c0 做错了
  const cand = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, ok: i > 0 && i < 19 }));
  const r = compareResults({ cases: cases(20), baseline: base, candidate: cand });
  assert.equal(r.verdict, "reject");
  assert.deepEqual(r.regressions, ["c0"]);
});

test("提升不足（<5%）→ reject", () => {
  const r = compareResults({ cases: cases(20), baseline: results(20, 14), candidate: results(20, 15), minDelta: 0.1 });
  assert.equal(r.verdict, "reject");
  assert.match(r.reason, /提升不足/);
});

test("样本不足 20 条 → refuse 不给结论", () => {
  const r = compareResults({ cases: cases(10), baseline: results(10, 5), candidate: results(10, 8) });
  assert.equal(r.verdict, "refuse");
  assert.match(r.reason, /不足 20/);
});

test("judgeWithSealed：没有封存用例 → refuse", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const r = judgeWithSealed(root, "py", { baseline: [], candidate: [] });
  assert.equal(r.verdict, "refuse");
  assert.match(r.reason, /没有封存用例/);
});

test("judgeWithSealed：有 20 条封存用例 → 正常判定", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench2-"));
  saveSealed(root, { skill: "py", cases: cases(20) });
  const r = judgeWithSealed(root, "py", { baseline: results(20, 12), candidate: results(20, 17) });
  assert.equal(r.verdict, "promote");
});
