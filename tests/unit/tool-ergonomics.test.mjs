// 子任务结果宽容解析 + 解释器/路径提示的回归测试（2026-10-29）
import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceResult, parseSubagentResult } from "../../engine/subagent-contract.mjs";
import { normalizeInterpreter } from "../../engine/tools/unified-tools.mjs";

test("数组交付被折成 result，不再判失败", () => {
  const r = coerceResult(["第一条", "第二条"]);
  assert.equal(r.result, "第一条\n第二条");
});

test("别名字段（text/content/answer）能救回来", () => {
  assert.equal(coerceResult({ text: "干完了" }).result, "干完了");
  assert.equal(coerceResult({ answer: "答案" }).result, "答案");
});

test("result 不是字符串（对象）也能用", () => {
  assert.match(coerceResult({ result: { a: 1 } }).result, /"a":1/);
});

test("非 JSON 原文当交付", () => {
  assert.equal(coerceResult(null, "一段纯文本").result, "一段纯文本");
});

test("空交付仍是 null（不能把空当完成）", () => {
  assert.equal(coerceResult(null, ""), null);
  assert.equal(coerceResult({}, ""), null);
  assert.equal(coerceResult([], ""), null);
});

test("parseSubagentResult 接受 text 形状的 JSON", () => {
  const r = parseSubagentResult({ text: JSON.stringify({ text: "用 text 字段交付的" }) }, { outputFormat: "json", maxChars: 1000, outputBudget: 1000 });
  assert.equal(r.result, "用 text 字段交付的");
});

test("parseSubagentResult 接受纯文本（非 JSON）", () => {
  const r = parseSubagentResult({ text: "就是一段话，没有 JSON" }, { outputFormat: "json", maxChars: 1000, outputBudget: 1000 });
  assert.match(r.result, /就是一段话/);
});

test("parseSubagentResult 仍然拒绝空输出", () => {
  assert.throws(() => parseSubagentResult({ text: "   " }, { outputFormat: "json", maxChars: 1000, outputBudget: 1000 }), /empty_output|无回复正文/);
});

test("python3 在 Windows 上换成 python", { skip: process.platform !== "win32" }, () => {
  assert.equal(normalizeInterpreter("python3 -V"), "python -V");
  assert.equal(normalizeInterpreter("echo ok && python3 x.py"), "echo ok && python x.py");
  assert.equal(normalizeInterpreter("python35 x"), "python35 x");
});
