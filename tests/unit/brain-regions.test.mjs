// 脑区旋钮：读写、换算、以及"它真的改变了行为"（2026-11-01）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REGIONS, REGION_IDS, readRegions, writeRegions, deliveryStrictness, distillLimit, nudgeCooldownMs, maxToolTurns, regionsPath, planBatchFactor, toolTier, filterToolsByTier, ADVANCED_TOOLS, ideaCap } from "../../engine/brain-regions.mjs";
import { judgeDelivery } from "../../engine/delivery-gate.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "brain-"));

test("8 个区，id 不重复", () => {
  assert.equal(REGIONS.length, 8);
  assert.equal(new Set(REGION_IDS).size, 8);
});

test("首次读会播种默认 0.5", () => {
  const root = ws();
  const r = readRegions(root);
  assert.equal(r.source, "seeded");
  for (const id of REGION_IDS) assert.equal(r.weights[id], 0.5);
  assert.ok(fs.existsSync(regionsPath(root)));
});

test("写局部更新，其他区保持不变；越界被夹到 0..1", () => {
  const root = ws();
  readRegions(root);
  const out = writeRegions(root, { verification: 0.9, social: 5, bogus: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.weights.verification, 0.9);
  assert.equal(out.weights.social, 1);
  assert.equal(out.weights.memory, 0.5);
  assert.equal(out.weights.bogus, undefined);
});

test("验证严格度：高/中/低三档", () => {
  assert.equal(deliveryStrictness({ verification: 0.9 }), "strict");
  assert.equal(deliveryStrictness({ verification: 0.5 }), "normal");
  assert.equal(deliveryStrictness({ verification: 0.1 }), "loose");
});

test("记忆权重 → 蒸馏条数 1..3", () => {
  assert.equal(distillLimit({ memory: 0 }), 1);
  assert.equal(distillLimit({ memory: 0.5 }), 2);
  assert.equal(distillLimit({ memory: 1 }), 3);
});

test("社交权重 → 冷却时间：高社交 2 小时，低社交 8 小时", () => {
  assert.equal(nudgeCooldownMs({ social: 1 }), 2 * 60 * 60 * 1000);
  assert.equal(nudgeCooldownMs({ social: 0 }), 8 * 60 * 60 * 1000);
});

test("分析权重 → 工具回合上限", () => {
  assert.equal(maxToolTurns({ analysis: 0 }), 12);
  assert.equal(maxToolTurns({ analysis: 1 }), 28);
  assert.ok(maxToolTurns({ analysis: 2 }) <= 40, "越界要被夹住");
});

test("真效果：验证权重高时，'声明已验证'不算覆盖 → RED", () => {
  const rows = [{ at: 10, phase: "before", tool: "write", argsPreview: JSON.stringify({ path: "a.mjs" }) }];
  const strict = judgeDelivery({ rows, verified: ["a.mjs"], strictness: "strict" });
  assert.equal(strict.verdict, "RED");
  assert.deepEqual(strict.uncovered, ["a.mjs"]);
});

test("真效果：验证权重低时，声明即算覆盖 → GREEN", () => {
  const rows = [{ at: 10, phase: "before", tool: "write", argsPreview: JSON.stringify({ path: "a.mjs" }) }];
  const loose = judgeDelivery({ rows, verified: ["a.mjs"], strictness: "loose" });
  assert.equal(loose.verdict, "GREEN");
  assert.deepEqual(loose.covered, ["a.mjs"]);
});

test("默认档：声明算覆盖但要标条件 → YELLOW", () => {
  const rows = [{ at: 10, phase: "before", tool: "write", argsPreview: JSON.stringify({ path: "a.mjs" }) }];
  const normal = judgeDelivery({ rows, verified: ["a.mjs"], strictness: "normal" });
  assert.equal(normal.verdict, "YELLOW");
});

test('规划权重 → 批次系数 0.5..1.5', () => {
  assert.equal(planBatchFactor({ planning: 0 }), 0.5);
  assert.equal(planBatchFactor({ planning: 0.5 }), 1);
  assert.equal(planBatchFactor({ planning: 1 }), 1.5);
});

test('工具档：低权重只留基础工具，高权重全给', () => {
  const tools = [
    { function: { name: 'read' } },
    { function: { name: 'write' } },
    { function: { name: 'cultivation' } },
    { function: { name: 'generate_image' } },
  ];
  assert.equal(toolTier({ tooling: 0.1 }), 'basic');
  assert.equal(toolTier({ tooling: 0.8 }), 'full');
  // 2026-11-06 策略变更：默认档也裁重工具（实测 55 个工具 1.7 万 token/次）。
  // 低权重 → 只留基础；高权重（>=0.7，明确要做复杂任务）→ 全给。
  assert.deepEqual(filterToolsByTier(tools, { tooling: 0.1 }).map((t) => t.function.name), ['read', 'write']);
  assert.deepEqual(filterToolsByTier(tools, { tooling: 0.5 }).map((t) => t.function.name), ['read', 'write']);
  assert.equal(filterToolsByTier(tools, { tooling: 0.8 }).length, 4);
});

test('工具档：如果过滤后一个都不剩，就不过滤（保命）', () => {
  const onlyAdvanced = [{ function: { name: 'cultivation' } }];
  assert.equal(filterToolsByTier(onlyAdvanced, { tooling: 0 }).length, 1);
});

test('高级工具集合包含 cultivation / computer_use', () => {
  assert.ok(ADVANCED_TOOLS.has('cultivation'));
  assert.ok(ADVANCED_TOOLS.has('computer_use'));
});

test('创造权重 → 建议条数 1..5', () => {
  assert.equal(ideaCap({ genesis: 0 }), 1);
  assert.equal(ideaCap({ genesis: 0.5 }), 3);
  assert.equal(ideaCap({ genesis: 1 }), 5);
});
