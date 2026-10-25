// 预算降级：选谁、为什么选它、以及"过预算"判定的读数来源。
// 之前这块只有 /api/budget/today 在算数，没有任何执行点（记忆里写的 429 硬停并不存在）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initModelRouter, pickBudgetDowngrade, markModelBlocked, resetModelHealth } from "../../engine/model-router.mjs";
import { readBudget, checkBudget } from "../../engine/token-budget.mjs";

const M = (provider, id, cost = {}) => ({ provider, id, name: id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost } });

function useModels(list) {
  initModelRouter({ getModelList: () => list, getDefaultModel: () => list[0] || null });
}

test("降级按真实单价升序：贵的让位给便宜的，排除当前模型与媒体模型", () => {
  resetModelHealth();
  const list = [
    M("api-top", "claude-opus-5", { input: 5, output: 25 }),
    M("tokenhub", "glm-5.3-flash", { input: 0.15, output: 0.5 }),
    M("plan", "free-flash", {}),                       // 0 价计划档
    M("agnes", "agnes-video-2.5-flash", {}),           // 媒体模型，绝不能选
  ];
  useModels(list);
  const pick = pickBudgetDowngrade(list[0]);
  assert.ok(pick, "应该选出一个候选");
  assert.equal(pick.id, "free-flash", `0 价的文本模型最便宜，实际选了 ${pick.provider}/${pick.id}`);
  assert.notEqual(pick.id, "agnes-video-2.5-flash", "视频模型不能拿来跑文本");
  assert.notEqual(pick.id, "claude-opus-5", "不能把当前模型当成降级目标");
});

test("同价时优先轻量档（flash/lite/mini）", () => {
  resetModelHealth();
  const list = [
    M("x", "some-big-model", {}),
    M("y", "vendor-mini", {}),
    M("z", "current-model", { input: 9, output: 9 }),
  ];
  useModels(list);
  const pick = pickBudgetDowngrade(list[2]);
  assert.equal(pick.id, "vendor-mini", "同价应挑轻量档");
});

test("冷却中的模型不参与降级", () => {
  resetModelHealth();
  const list = [M("a", "cheap-flash", {}), M("b", "other-flash", { input: 1, output: 1 }), M("c", "current", { input: 9, output: 9 })];
  useModels(list);
  markModelBlocked(list[0], { ms: 60_000, reason: "429" });
  const pick = pickBudgetDowngrade(list[2]);
  assert.equal(pick.id, "other-flash", "冷却里的便宜模型不能被选中");
  resetModelHealth();
});

test("没有可用候选就返回 null（调用方只提示、不硬停）", () => {
  resetModelHealth();
  const only = M("a", "only-model", { input: 1, output: 1 });
  useModels([only]);
  assert.equal(pickBudgetDowngrade(only), null);
  resetModelHealth();
  useModels([{ provider: "a", id: "seedance-video-2", cost: { input: 0, output: 0 } }]);
  assert.equal(pickBudgetDowngrade(null), null, "只剩媒体模型时也不能选");
});

test("预算文件：downgrade 默认开、可关；过线判定分 ok/warn/hard", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  fs.mkdirSync(path.join(ws, "记忆", "运行时"), { recursive: true });
  const file = path.join(ws, "记忆", "运行时", "token预算.json");
  const profile = path.join(ws, "记忆", "运行时", "每轮耗时.jsonl");

  assert.equal(readBudget(ws).downgrade, true, "没有配置文件时默认允许降级");
  fs.writeFileSync(file, JSON.stringify({ dailyTokens: 200000, hardMultiplier: 2.5 }), "utf8");
  assert.equal(readBudget(ws).downgrade, true);
  fs.writeFileSync(file, JSON.stringify({ dailyTokens: 200000, downgrade: false }), "utf8");
  assert.equal(readBudget(ws).downgrade, false, "显式关掉就该只提示不换");

  // 用量取自 每轮耗时.jsonl 的 usage 累加。注意 dailyTokens 有 10 万下限钳制，
  // 所以这里用真实量级（150k / 200k），别拿 1100 去测 1000 的预算——会被钳成 0.011%。
  const at = new Date().toISOString();
  const writeUsage = (total) => {
    const rows = [
      { at, model: { provider: "p" }, usage: { calls: 1, input: Math.round(total * 0.6), output: total - Math.round(total * 0.6), cacheRead: 0, cacheWrite: 0 } },
    ];
    fs.writeFileSync(profile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  };
  writeUsage(150_000);
  fs.writeFileSync(file, JSON.stringify({ dailyTokens: 200000 }), "utf8");
  const warn = checkBudget(ws);
  assert.equal(warn.total, 150_000);
  assert.equal(warn.level, "ok", "150k/200k = 75%，还没过线");

  fs.writeFileSync(file, JSON.stringify({ dailyTokens: 100000 }), "utf8");
  const over = checkBudget(ws);
  assert.equal(over.level, "warn", "150k/100k = 1.5 倍，过线是 warn");
  assert.equal(over.budget.downgrade, true);

  fs.writeFileSync(file, JSON.stringify({ dailyTokens: 100000, hardMultiplier: 1.2 }), "utf8");
  assert.equal(checkBudget(ws).level, "hard", "1.5 倍 ≥ 1.2 的硬线，属于 hard 档");
});
