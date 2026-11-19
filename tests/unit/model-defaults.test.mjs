// 模型中心「默认设置」：默认模型 / 兜底顺序 / 每日预算，改完立即生效（2026-11-19）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initModelRouter, setUserFallbacks, pickFallbackDefault, pickFallbackExcluding, pickBudgetDowngrade, markModelBlocked, resetModelHealth } from "../../engine/model/router.mjs";
import { createModelDefaults, readUserFallbacks } from "../../engine/model/defaults.mjs";

const M = (provider, id) => ({ provider, id, name: id, cost: { input: 0, output: 0 } });
const LIST = [M("deepseek", "deepseek-flash"), M("agnes", "agnes-3.0-flash"), M("openrouter", "free-chat"), M("agnes", "agnes-video-2.5-flash")];

function setup() {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-agent-"));
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "md-ws-"));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", defaultProvider: "deepseek", defaultModel: "deepseek-flash" }));
  let def = LIST[0];
  initModelRouter({ getModelList: () => LIST, getDefaultModel: () => def });
  setUserFallbacks([]);
  resetModelHealth();
  const md = createModelDefaults({ agentDir, wsRoot, getModelList: () => LIST, getDefaultModel: () => def, setDefaultModel: (m) => { def = m }, setFallbacks: setUserFallbacks, todayUsage: () => ({ total: 123 }) });
  return { agentDir, wsRoot, md, getDef: () => def };
}

test("改默认模型：写进 settings.json（保留其他字段）并立即生效", () => {
  const { agentDir, md, getDef } = setup();
  const r = md.save({ defaultModel: "agnes/agnes-3.0-flash" });
  assert.equal(r.defaultModel, "agnes/agnes-3.0-flash");
  assert.equal(getDef().id, "agnes-3.0-flash");
  const s = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual([s.defaultProvider, s.defaultModel, s.theme], ["agnes", "agnes-3.0-flash", "dark"]);
});

test("默认模型不能选媒体模型或不存在的模型", () => {
  const { md } = setup();
  assert.throws(() => md.save({ defaultModel: "agnes/agnes-video-2.5-flash" }), /文本/);
  assert.throws(() => md.save({ defaultModel: "x/y" }), /不在/);
});

test("兜底顺序：排在前面的先用，冷却中的跳过，三条链都认", () => {
  const { agentDir, md } = setup();
  md.save({ fallbacks: ["openrouter/free-chat", "agnes/agnes-3.0-flash"] });
  assert.deepEqual(readUserFallbacks(agentDir), ["openrouter/free-chat", "agnes/agnes-3.0-flash"]);
  markModelBlocked(LIST[0], "402");
  assert.equal(pickFallbackDefault().id, "free-chat");
  assert.equal(pickFallbackExcluding(LIST[2]).id, "agnes-3.0-flash");
  assert.equal(pickBudgetDowngrade(LIST[0]).id, "free-chat");
  markModelBlocked(LIST[2], "429");
  assert.equal(pickFallbackDefault().id, "agnes-3.0-flash");
  setUserFallbacks([]);
});

test("兜底里有坏项整体不改；预算校验与读数", () => {
  const { wsRoot, md } = setup();
  assert.throws(() => md.save({ fallbacks: ["openrouter/free-chat", "nope/x"], dailyTokens: 5_000_000 }), /nope\/x/);
  assert.deepEqual(md.get().fallbacks, []);
  assert.equal(fs.existsSync(path.join(wsRoot, "记忆", "运行时", "token预算.json")), false);
  assert.throws(() => md.save({ dailyTokens: 10 }), /10 万/);
  const r = md.save({ dailyTokens: 100_000_000, downgrade: false });
  assert.deepEqual(r.budget, { enabled: true, dailyTokens: 100_000_000, downgrade: false, usedToday: 123 });
});
