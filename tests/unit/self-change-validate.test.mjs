// 方案 B：边界 → 测试 → 交付门，三道都过才放行（2026-11-02）
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCandidate } from "../../engine/self-change-validate.mjs";

const files = ["engine/foo.mjs"];
const passTests = async () => ({ ok: true, detail: "ok" });
const greenGate = async () => ({ verdict: "GREEN" });

test("边界不过：第一道就拒，不跑测试", async () => {
  let ran = false;
  const r = await validateCandidate({ files: ["server.mjs"], runTests: async () => { ran = true; return { ok: true } }, runGate: greenGate });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "policy");
  assert.equal(ran, false, "不应该跑测试");
});

test("测试不过：拦在第二道", async () => {
  const r = await validateCandidate({ files, runTests: async () => ({ ok: false, detail: "1 failing" }), runGate: greenGate });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "tests");
  assert.match(r.errors[0], /测试/);
});

test("交付门不是 GREEN：拦在第三道", async () => {
  for (const v of ["YELLOW", "RED", ""]) {
    const r = await validateCandidate({ files, runTests: passTests, runGate: async () => ({ verdict: v }) });
    assert.equal(r.ok, false, v);
    assert.equal(r.stage, "gate", v);
  }
});

test("三道都过 → green", async () => {
  const r = await validateCandidate({ files, runTests: passTests, runGate: greenGate });
  assert.equal(r.ok, true);
  assert.equal(r.stage, "green");
  assert.equal(r.gate.verdict, "GREEN");
});

test("测试/交付门抛异常也拦住，不崩", async () => {
  const r1 = await validateCandidate({ files, runTests: async () => { throw new Error("boom") }, runGate: greenGate });
  assert.equal(r1.ok, false);
  assert.equal(r1.stage, "tests");
  const r2 = await validateCandidate({ files, runTests: passTests, runGate: async () => { throw new Error("gate down") } });
  assert.equal(r2.ok, false);
  assert.equal(r2.stage, "gate");
});

test("没给跑法直接拒：避免无验证就放行", async () => {
  const r = await validateCandidate({ files });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "tests");
});
