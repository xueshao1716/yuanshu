// 用例执行器：并发/超时/落盘（2026-11-03）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCases, saveResults, loadResults, runAndSave } from "../../engine/learning/case-runner.mjs";
import { saveSealed } from "../../engine/learning/sealed-cases.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
const cases = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, input: `in${i}`, expect: `out${i}` }));

test("跑 4 条：2 过 2 挂，结果按 id 排序", async () => {
  const out = await runCases({ cases: cases(4), runCase: async (c) => ({ ok: Number(c.id.slice(1)) % 2 === 0 }) });
  assert.equal(out.ok, true);
  assert.equal(out.total, 4);
  assert.equal(out.passed, 2);
  assert.deepEqual(out.results.map((r) => r.id), ["c0", "c1", "c2", "c3"]);
});

test("执行器抛错 → 该条记失败，不影响其他", async () => {
  const out = await runCases({ cases: cases(3), runCase: async (c) => { if (c.id === "c1") throw new Error("boom"); return { ok: true } } });
  assert.equal(out.passed, 2);
  assert.equal(out.results.find((r) => r.id === "c1").ok, false);
  assert.match(out.results.find((r) => r.id === "c1").error, /boom/);
});

test("单例超时 → 记失败", async () => {
  const out = await runCases({ cases: [{ id: "slow" }], runCase: () => new Promise((r) => setTimeout(() => r({ ok: true }), 200)), timeoutMs: 30 });
  assert.equal(out.results[0].ok, false);
  assert.match(out.results[0].error, /超时/);
});

test("没有执行器 → 明确拒绝", async () => {
  const out = await runCases({ cases: cases(2) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /runCase/);
});

test("结果落盘与读回", () => {
  const root = ws();
  saveResults(root, { skill: "py", version: "baseline", results: [{ id: "c0", ok: true }] });
  const back = loadResults(root, "py", "baseline");
  assert.equal(back.skill, "py");
  assert.equal(back.results.length, 1);
});

test("runAndSave：没有封存用例就拒绝", async () => {
  const out = await runAndSave(ws(), { skill: "nope", version: "v1", runCase: async () => ({ ok: true }) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /没有封存用例/);
});

test("runAndSave：有考卷 → 跑完落盘", async () => {
  const root = ws();
  saveSealed(root, { skill: "py", cases: cases(20) });
  const out = await runAndSave(root, { skill: "py", version: "candidate-1", runCase: async (c) => ({ ok: c.id.endsWith("0") }) });
  assert.equal(out.ok, true);
  assert.equal(out.total, 20);
  assert.equal(out.saved, true);
  const back = loadResults(root, "py", "candidate-1");
  assert.equal(back.results.length, 20);
});
