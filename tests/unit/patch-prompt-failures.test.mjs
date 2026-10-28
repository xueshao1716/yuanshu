// 生成器提示词带历史失败：单测（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../../engine/patch-generator.mjs";

test("有 knownFailures：提示词里要出现「不要重复」和具体教训", () => {
  const p = buildPrompt({
    title: "作业不执行",
    symptom: "cmd 脚本跑不起来",
    files: ["engine/detached-run.mjs"],
    accept: "作业能执行",
    knownFailures: [
      { attempt: "给 .cmd 加 UTF-8 BOM", why: "真根因是 .cmd 不能带 BOM" },
    ],
  });
  assert.match(p, /不要重复/);
  assert.match(p, /加 UTF-8 BOM/);
  assert.match(p, /不能带 BOM/);
});

test("没有 knownFailures：不该出现那一节（别污染普通提示词）", () => {
  const p = buildPrompt({ title: "普通问题", files: ["a.mjs"], accept: "ok" });
  assert.ok(!p.includes("不要重复"));
});

test("最多只带 5 条（防止提示词膨胀）", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ attempt: `方案${i}`, why: `原因${i}` }));
  const p = buildPrompt({ title: "x", files: ["a.mjs"], knownFailures: many });
  const hits = [...p.matchAll(/试过：/g)].length;
  assert.equal(hits, 5);
});
