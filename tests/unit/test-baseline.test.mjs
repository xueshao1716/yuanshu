// 门禁只拦新增红灯（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFailures, newFailures, summaryOf, loadBaseline, saveBaseline } from "../../engine/test-baseline.mjs";

const SPEC = [
  "",
  "✖ 老问题 A (3.0ms)",
  "✖ 新问题 B (1.2ms)",
  "ℹ tests 10",
  "✖ failing tests:",
  "✖ 老问题 A (3.0ms)",
  "✖ 新问题 B (1.2ms)",
].join("\n");

const TAP = ["not ok 1 - 老问题 A", "not ok 2 - 新问题 B", "ok 3 - 好的"].join("\n");

test("两种输出都能解析出失败名（并去掉标题行）", () => {
  assert.deepEqual(parseFailures(SPEC).sort(), ["新问题 B", "老问题 A"].sort());
  assert.deepEqual(parseFailures(TAP).sort(), ["新问题 B", "老问题 A"].sort());
  assert.ok(!parseFailures(SPEC).includes("failing tests:"));
});

test("基线里的红灯不算新增，只拦新的", () => {
  const fresh = newFailures(SPEC, ["老问题 A"]);
  assert.deepEqual(fresh, ["新问题 B"]);
});

test("没有基线时，所有红灯都算新增（第一次建基线之前要人看一眼）", () => {
  assert.equal(newFailures(SPEC, []).length, 2);
});

test("summary 说清楚：已知几条、新增几条", () => {
  const s = summaryOf(SPEC, ["老问题 A"]);
  assert.equal(s.total, 2);
  assert.equal(s.known, 1);
  assert.deepEqual(s.fresh, ["新问题 B"]);
});

test("基线文件读写往返", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-"));
  const file = saveBaseline(root, ["b", "a", "a"], { note: "人工确认过" });
  assert.ok(fs.existsSync(file));
  assert.deepEqual(loadBaseline(root), ["a", "b"]);
  assert.deepEqual(loadBaseline(fs.mkdtempSync(path.join(os.tmpdir(), "none-"))), []);
});
