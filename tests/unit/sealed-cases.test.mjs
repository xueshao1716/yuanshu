// 封存用例：只能人来建、被改动要拒绝、样本量门槛（2026-11-03）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveSealed, loadSealed, canUseAsBenchmark, sealedPath, MIN_CASES } from "../../engine/learning/sealed-cases.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "sealed-"));
const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, input: `in${i}`, expect: `out${i}` }));

test("Agent 不能创建封存用例", () => {
  const root = ws();
  const r = saveSealed(root, { skill: "py", cases: mk(3), by: "agent" });
  assert.equal(r.ok, false);
  assert.match(r.error, /只能由人/);
});

test("人建 20 条 → 可作基准", () => {
  const root = ws();
  assert.equal(saveSealed(root, { skill: "py", cases: mk(MIN_CASES) }).ok, true);
  const c = canUseAsBenchmark(root, "py");
  assert.equal(c.ok, true);
  assert.equal(c.count, MIN_CASES);
});

test("不足 20 条 → 不能作基准", () => {
  const root = ws();
  saveSealed(root, { skill: "py", cases: mk(5) });
  const c = canUseAsBenchmark(root, "py");
  assert.equal(c.ok, false);
  assert.match(c.reason, /至少需要/);
});

test("被改动过 → 哈希不符，拒绝使用", () => {
  const root = ws();
  saveSealed(root, { skill: "py", cases: mk(MIN_CASES) });
  const file = sealedPath(root, "py");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.cases[0].expect = "被偷偷改过";
  fs.writeFileSync(file, JSON.stringify(doc), "utf8");
  const r = loadSealed(root, "py");
  assert.equal(r.ok, false);
  assert.match(r.error, /改动过/);
  assert.equal(canUseAsBenchmark(root, "py").ok, false);
});

test("没有文件 → 明确报没有", () => {
  assert.match(loadSealed(ws(), "nope").error, /没有封存用例/);
});

test("skill 名里的非法字符被替换", () => {
  const root = ws();
  saveSealed(root, { skill: "a/b:c", cases: mk(MIN_CASES) });
  assert.ok(fs.existsSync(path.join(root, "记忆", "进化", "封存用例", "a_b_c.json")));
});
