// 退化自评 + 自救阶梯 + 全局暂停闸（2026-11-09）
// 钉住四件事：
//   ① 五个子分各自有真实信号、正常→低分 / 坏→高分，缺数据必须 unevaluated（不能拿 0 冒充健康）；
//   ② 总分只按已评估维度归一（算式写死在这里），等级阈值边界不飘；
//   ③ 动作阶梯按等级放行（degraded 只出 low，critical 才出 text-only/global-pause），重复评估不重复落账；
//   ④ 闸：只有 high 风险动作能写全局闸且必须带理由；写完之后**真的有人读**（静态断言 + decide 实测）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  THRESHOLDS, DIMENSIONS, ACTIONS, HIGH_RISK_ACTIONS,
  COMPETENCE, HALLUCINATION, CONTEXT, MODEL, SUBAGENT, ACTION_COOLDOWN_MS, AUTO_RELEASE_HOLD_MS,
  levelOf, assessDegradation, pickActions,
  scoreCompetence, scoreHallucination, scoreContextPressure, scoreModelStability, scoreSubagents,
  collectSignals, assessWorkspace, degradationSnapshot,
  readPauseGate, setPauseGate, isPaused,
  applyActions, actionKey, readActionLog,
  PAUSE_REL, ACTION_LOG_REL,
} from "../../engine/degradation.mjs";
import { decide } from "../../engine/proactive-policy.mjs";
import { sendOut, readLedger } from "../../engine/outbound.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "degradation-"));
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const write = (root, rel, body) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body), "utf8");
};
const NOW = new Date(2026, 10, 9, 21, 0, 0, 0).getTime();   // 本地 21:00，避开死夜
const MIN = 60 * 1000;

// 五个维度都健康的信号（每维都有数据，也就是说 evaluated 全是 true）
const healthySignals = () => ({
  competence: { toolCalls: 40, toolFailures: 2, deliveries: { total: 10, green: 9 } },
  hallucination: { hits: [] },
  context: { usedTokens: 20_000, contextWindow: 200_000 },
  model: { failures: { provider: 0, timeout: 0, model: 0, other: 0 }, turns: { total: 20, slow: 0, empty: 0 } },
  subagents: { items: [{ id: "s1", status: "done", startedAt: new Date(NOW - 5 * MIN).toISOString() }], now: NOW },
});
// 五个维度都坏的信号
const badSignals = () => ({
  competence: { toolCalls: 20, toolFailures: 16, deliveries: { total: 10, green: 3 } },
  hallucination: { hits: [{ id: "AP-002", at: NOW, severity: "high" }, { id: "AP-009", at: NOW, severity: "high" }, { id: "AP-012", at: NOW, severity: "high" }] },
  context: { usedTokens: 192_000, contextWindow: 200_000 },
  model: { failures: { provider: 3, timeout: 2, model: 0, other: 0 }, turns: { total: 20, slow: 3, empty: 2 } },
  subagents: { items: [
    { id: "s1", status: "running", startedAt: new Date(NOW - 40 * MIN).toISOString(), timeoutMs: 15 * MIN },
    { id: "s2", status: "running", startedAt: new Date(NOW - 30 * MIN).toISOString(), timeoutMs: 15 * MIN },
  ], now: NOW },
});

// ───────────────────────── 一、五维子分：正常 → 低，坏 → 高 ─────────────────────────

test("胜任：工具失败率 + 交付门非 GREEN 各算一档，正常低分、坏高分、样本不足不判", () => {
  const good = scoreCompetence({ competence: { toolCalls: 40, toolFailures: 2, deliveries: { total: 10, green: 9 } } });
  assert.equal(good.evaluated, true);
  // 0.05/0.35 = 0.1429（×0.6） + 0.1/0.5 = 0.2（×0.4） → 0.1657
  assert.ok(Math.abs(good.score - (0.05 / COMPETENCE.toolFull * 0.6 + 0.1 / COMPETENCE.redFull * 0.4)) < 1e-6);
  assert.ok(good.score < 0.2, `正常应低分，实际 ${good.score}`);

  const bad = scoreCompetence({ competence: badSignals().competence });
  assert.equal(bad.evaluated, true);
  assert.ok(bad.score > 0.9, `坏应高分，实际 ${bad.score}`);

  // 只有工具、没有交付门样本 → 权重在已用来源上重新归一（不是乘 0.6 就完事）
  const onlyTools = scoreCompetence({ competence: { toolCalls: 40, toolFailures: 0 } });
  assert.equal(onlyTools.evaluated, true);
  assert.equal(onlyTools.score, 0);

  const none = scoreCompetence({ competence: { toolCalls: 2, toolFailures: 2 } });
  assert.equal(none.evaluated, false, "样本不足（<5 次）必须 unevaluated");
  assert.equal(scoreCompetence({}).evaluated, false, "没有信号必须 unevaluated");
});

test("幻觉：只认幻觉类反模式 id、severity 加权；一次没命中是真的 0 分，不是看不见", () => {
  assert.equal(scoreHallucination({ hallucination: { hits: [] } }).score, 0);
  assert.equal(scoreHallucination({ hallucination: { hits: [] } }).evaluated, true);

  // 一条 high = 1/3
  const one = scoreHallucination({ hallucination: { hits: [{ id: "AP-002", severity: "high" }] } });
  assert.ok(Math.abs(one.score - 1 / HALLUCINATION.hitFull) < 1e-9);
  // 三条 high 拉满
  assert.equal(scoreHallucination({ hallucination: badSignals().hallucination }).score, 1);
  // 非幻觉类（AP-004 之类）不计分，但记录在 evidence 里
  const other = scoreHallucination({ hallucination: { hits: [{ id: "AP-004", severity: "high" }] } });
  assert.equal(other.score, 0);
  assert.equal(other.evidence.hits, 1);
  // medium 权重 0.6
  const med = scoreHallucination({ hallucination: { hits: [{ id: "AP-001", severity: "medium" }] } });
  assert.ok(Math.abs(med.score - 0.6 / HALLUCINATION.hitFull) < 1e-9);
  // 没有命中记录（文件都没有）→ unevaluated
  assert.equal(scoreHallucination({}).evaluated, false);
});

test("上下文：用 lastCtx/窗口算真 headroom，窗口缺失标 estimated，余量紧张至少 0.85", () => {
  const ok = scoreContextPressure({ context: { usedTokens: 20_000, contextWindow: 200_000 } });
  assert.equal(ok.evaluated, true);
  assert.equal(ok.score, 0, "10% 占用不该有压力");

  const mid = scoreContextPressure({ context: { usedTokens: 130_000, contextWindow: 200_000 } });
  // (0.65-0.5)/0.45 = 0.3333
  assert.ok(Math.abs(mid.score - 0.3333) < 0.001, `实际 ${mid.score}`);

  const full = scoreContextPressure({ context: { usedTokens: 192_000, contextWindow: 200_000 } });
  assert.equal(full.evidence.tight, true, "余量 3.9k < 8k 应判 tight");
  assert.ok(full.score >= CONTEXT.tightFloor);

  const estimated = scoreContextPressure({ context: { usedTokens: 150_000, contextWindow: 0 } });
  assert.equal(estimated.evaluated, true);
  assert.equal(estimated.evidence.estimated, true);
  assert.equal(estimated.evidence.contextWindow, CONTEXT.defaultWindow);
  assert.match(estimated.note, /估/);

  assert.equal(scoreContextPressure({}).evaluated, false);
  assert.equal(scoreContextPressure({ context: { contextWindow: 200_000 } }).evaluated, false, "没有占用数不许编");
});

test("模型稳定：provider/超时/空回复/慢轮按权重加总，只有轮次数据也能判", () => {
  const good = scoreModelStability({ model: healthySignals().model });
  assert.equal(good.evaluated, true);
  assert.equal(good.score, 0);

  const bad = scoreModelStability({ model: badSignals().model });
  // 3×1 + 2×0.8 + 2×0.5 + 3×0.3 = 6.5 → 拉满
  assert.equal(bad.evidence.weighted, 6.5);
  assert.equal(bad.score, 1);

  const half = scoreModelStability({ model: { failures: { provider: 2 }, turns: { total: 10 } } });
  assert.ok(Math.abs(half.score - 2 / MODEL.failFull) < 1e-9);

  // 没有失败台账、但轮次够 → 用慢轮/空回复判（evaluated，不是 unevaluated）
  const turnsOnly = scoreModelStability({ model: { turns: { total: 10, slow: 2, empty: 0 } } });
  assert.equal(turnsOnly.evaluated, true);
  assert.ok(turnsOnly.score > 0);

  assert.equal(scoreModelStability({ model: { turns: { total: 1 } } }).evaluated, false, "轮次太少不许判");
  assert.equal(scoreModelStability({}).evaluated, false);
});

test("子体：running 超自己的 timeoutMs 算卡死、failed+timeout 算超时；没有登记表=unevaluated", () => {
  const good = scoreSubagents({ subagents: healthySignals().subagents });
  assert.equal(good.evaluated, true);
  assert.equal(good.score, 0);

  const bad = scoreSubagents({ subagents: badSignals().subagents });
  assert.equal(bad.evidence.stalled, 2);
  assert.equal(bad.score, 1);
  assert.deepEqual(bad.evidence.ids, ["s1", "s2"]);

  // running 但没超时：不算卡死
  const runningFresh = scoreSubagents({ subagents: { now: NOW, items: [{ id: "a", status: "running", startedAt: new Date(NOW - 5 * MIN).toISOString() }] } });
  assert.equal(runningFresh.evidence.stalled, 0);
  assert.equal(runningFresh.score, 0);

  // 超时失败：0.6/2 = 0.3
  const timeout = scoreSubagents({ subagents: { now: NOW, items: [{ id: "b", status: "failed", errorCode: "timeout" }] } });
  assert.ok(Math.abs(timeout.score - SUBAGENT.weight.timeout / SUBAGENT.fullWeighted) < 1e-9);

  assert.equal(scoreSubagents({}).evaluated, false);
  assert.equal(scoreSubagents({ subagents: {} }).evaluated, false);
});

// ───────────────────────── 二、总分归一 + 等级边界 ─────────────────────────

test("缺维度 → unevaluated，总分按已评估归一（算式断言）", () => {
  // 只给两维：胜任拉满 1.0，幻觉干净 0.0
  const a = assessDegradation({
    now: NOW,
    signals: {
      competence: { toolCalls: 20, toolFailures: 16, deliveries: { total: 10, green: 3 } },
      hallucination: { hits: [] },
    },
  });
  assert.equal(a.evaluated.length, 2);
  assert.deepEqual(new Set(a.unevaluated), new Set(["contextPressure", "modelStability", "subagents"]));
  assert.equal(a.subscores.contextPressure.evaluated, false);
  assert.equal(a.subscores.contextPressure.score, 0);
  assert.ok(a.subscores.contextPressure.note, "未评估必须写清为什么");
  // 算式：均值只除已评估的个数 = (1.0 + 0.0) / 2 = 0.5
  assert.equal(a.meanScore, 0.5);
  // 总分 = 0.6×均值 + 0.4×最差 = 0.6×0.5 + 0.4×1.0 = 0.7
  assert.equal(a.score, 0.7);
  assert.equal(a.worstScore, 1);
  // 最坏一维打到硬线（≥0.9）→ 等级被单维抬到 critical，但只出低风险动作
  assert.equal(a.level, "critical");
  assert.equal(a.levelFrom, "worst-dim");
  assert.deepEqual(a.actions.map((x) => x.action), ["pause-proactive"]);

  // 同样的两维，但如果把差的维度换成"只差一点"，等级就回到 score 决定
  const b = assessDegradation({
    now: NOW,
    signals: {
      competence: { toolCalls: 40, toolFailures: 2, deliveries: { total: 10, green: 9 } },  // 0.1657
      hallucination: { hits: [{ id: "AP-002" }, { id: "AP-009" }] },                        // 0.6667
    },
  });
  assert.ok(Math.abs(b.meanScore - (0.1657 + 0.6667) / 2) < 0.001);
  assert.equal(b.levelFrom, "score");
  assert.equal(b.level, "degraded");

  // 一维都没有 → 0 分、healthy，但 unevaluated 全 5，reasons 里逐条说清
  const none = assessDegradation({ now: NOW, signals: {} });
  assert.equal(none.score, 0);
  assert.equal(none.meanScore, 0);
  assert.equal(none.worstScore, 0);
  assert.equal(none.level, "healthy");
  assert.equal(none.unevaluated.length, 5);
  assert.equal(none.actions.length, 0);
  assert.ok(none.reasons.some((r) => /未评估/.test(r)));

  // 健康信号 → 低分 healthy
  const h = assessDegradation({ now: NOW, signals: healthySignals() });
  assert.equal(h.evaluated.length, 5);
  assert.ok(h.score < THRESHOLDS.degraded, `健康信号总分应低于退化线，实际 ${h.score}`);
  assert.equal(h.level, "healthy");
  assert.equal(h.levelFrom, "score");
  assert.deepEqual(h.actions, []);
});

test("等级阈值：healthy <0.45 / degraded 0.45-0.72 / critical ≥0.72（边界不飘）", () => {
  assert.equal(THRESHOLDS.degraded, 0.45);
  assert.equal(THRESHOLDS.critical, 0.72);
  assert.equal(levelOf(0), "healthy");
  assert.equal(levelOf(0.4499), "healthy");
  assert.equal(levelOf(0.45), "degraded");
  assert.equal(levelOf(0.7199), "degraded");
  assert.equal(levelOf(0.72), "critical");
  assert.equal(levelOf(1), "critical");
  assert.equal(levelOf(NaN), "healthy");

  // 端到端：上下文吃满 90% → 总分过退化线，靠 score 而不是硬线
  const degraded = assessDegradation({ now: NOW, signals: { ...healthySignals(), context: { usedTokens: 180_000, contextWindow: 200_000 } } });
  assert.ok(degraded.score >= THRESHOLDS.degraded, `实际 ${degraded.score}`);
  assert.equal(degraded.level, "degraded");
  assert.equal(degraded.levelFrom, "score");
  // 单维硬线：最坏一维 ≥0.9 即使混合分没到 0.72 也判 critical
  const hard = assessDegradation({ now: NOW, signals: { ...healthySignals(), hallucination: { hits: [{ id: "AP-002" }, { id: "AP-009" }, { id: "AP-012" }] } } });
  assert.ok(hard.score < THRESHOLDS.critical, `混合分应该还没到 critical，实际 ${hard.score}`);
  assert.equal(hard.worstScore, 1);
  assert.equal(hard.level, "critical");
});

// ───────────────────────── 三、动作阶梯 ─────────────────────────

test("degraded 只出低风险动作；text-only / global-pause 只有 critical 才出现", () => {
  // degraded：只有上下文一维高（其余健康）→ 只出 compress-session（low）
  const degraded = assessDegradation({ now: NOW, signals: { ...healthySignals(), context: { usedTokens: 180_000, contextWindow: 200_000 } } });
  assert.equal(degraded.level, "degraded");
  assert.ok(degraded.actions.length > 0);
  for (const a of degraded.actions) {
    assert.equal(a.risk, "low", `degraded 不许出 ${a.risk} 风险动作：${a.action}`);
    assert.ok(!["text-only", "global-pause"].includes(a.action));
    assert.equal(a.reversible, true);
    assert.ok(a.reason && a.reason.length > 4, "每个动作都要带理由");
  }
  assert.ok(degraded.actions.some((a) => a.action === "compress-session"));

  // critical：五维全坏 → 阶梯全出，含 high 的 global-pause
  const critical = assessDegradation({ now: NOW, signals: badSignals() });
  assert.equal(critical.level, "critical");
  const names = critical.actions.map((a) => a.action);
  assert.deepEqual(names, ACTIONS_KEYS, "五维全坏时六个动作应全出（顺序按阶梯）");
  const global = critical.actions.find((a) => a.action === "global-pause");
  assert.equal(global.risk, "high");
  assert.equal(global.reversible, true);
  assert.ok(names.indexOf("global-pause") > names.indexOf("text-only"), "global-pause 必须在阶梯最后");
  // 风险单调不减：low → medium → high
  const rank = { low: 0, medium: 1, high: 2 };
  const risks = critical.actions.map((a) => rank[a.risk]);
  assert.deepEqual(risks, [...risks].sort((x, y) => x - y), "阶梯必须低风险优先");
});

test("单维触发：幻觉高但总分没到 critical → 只 pause-proactive（不出 global-pause）", () => {
  const signals = {
    hallucination: { hits: [{ id: "AP-002", severity: "high" }, { id: "AP-009", severity: "high" }] },  // 0.667
    competence: { toolCalls: 40, toolFailures: 2, deliveries: { total: 10, green: 9 } },               // ~0.166
  };
  const a = assessDegradation({ now: NOW, signals });
  assert.equal(a.level, "degraded");
  const names = a.actions.map((x) => x.action);
  assert.deepEqual(names, ["pause-proactive"]);
  assert.equal(a.actions[0].risk, "low");

  // 未评估的维度不许当触发条件：只给上下文且未评估时，pickActions 不挑任何需要它的动作
  assert.deepEqual(pickActions({ contextPressure: { score: 0.9, evaluated: false, evidence: {} } }, "critical"), []);
});

// ───────────────────────── 四、幂等 ─────────────────────────

test("幂等：同一状态重复评估不重复追加动作；状态变了才再记一条", () => {
  const root = ws();
  const a1 = assessDegradation({ now: NOW, signals: badSignals() });
  const r1 = applyActions({ wsRoot: root, assessment: a1, now: NOW, by: "test" });
  assert.equal(r1.ok, true);
  assert.equal(r1.recorded, true);
  assert.equal(r1.applied.length, ACTIONS_KEYS.length);

  const lines1 = fs.readFileSync(path.join(root, ACTION_LOG_REL), "utf8").trim().split("\n");
  assert.equal(lines1.length, 1);
  assert.equal(JSON.parse(lines1[0]).key, actionKey(a1));

  // 同一状态、同一时刻再执行一次 → 不追加
  const a2 = assessDegradation({ now: NOW, signals: badSignals() });
  assert.equal(actionKey(a2), actionKey(a1), "同样的信号必须得到同样的动作键");
  const r2 = applyActions({ wsRoot: root, assessment: a2, now: NOW + MIN, by: "test" });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.recorded, false);
  assert.equal(fs.readFileSync(path.join(root, ACTION_LOG_REL), "utf8").trim().split("\n").length, 1);

  // 超过冷却窗 → 允许再记（状态没变但确实过了半小时）
  const r3 = applyActions({ wsRoot: root, assessment: a2, now: NOW + ACTION_COOLDOWN_MS + 1, by: "test" });
  assert.equal(r3.recorded, true);

  // 状态变了（等级降到 healthy）→ 新键、新记录
  const healthy = assessDegradation({ now: NOW, signals: healthySignals() });
  const r4 = applyActions({ wsRoot: root, assessment: healthy, now: NOW + ACTION_COOLDOWN_MS + 2, by: "test" });
  assert.equal(r4.recorded, true);
  assert.equal(readActionLog(root, { limit: 5 }).length, 3);
});

const ACTIONS_KEYS = ["compress-session", "switch-model", "pause-proactive", "freeze-subagents", "text-only", "global-pause"];

test("自动解除：连续 healthy 且闸是自己挂的、挂够 30 分钟 → 分项闸放回；全局闸永不自动解", () => {
  const root = ws();
  const bad = assessDegradation({ now: NOW, signals: badSignals() });
  const r1 = applyActions({ wsRoot: root, assessment: bad, now: NOW, by: "degradation" });
  assert.equal(r1.recorded, true);
  let gate = readPauseGate(root);
  assert.equal(gate.on, true, "五维全坏时 global-pause 应把全局闸挂上");
  assert.equal(gate.scopes.proactive, true);
  assert.equal(gate.scopes.media, true);

  // 健康了，但全局闸不归自动解除管
  const healthy = assessDegradation({ now: NOW, signals: healthySignals() });
  const r2 = applyActions({ wsRoot: root, assessment: healthy, now: NOW + AUTO_RELEASE_HOLD_MS + 1, by: "degradation" });
  assert.equal(r2.recorded, true);
  assert.equal(readPauseGate(root).on, true, "全局闸必须等人解，不许自动恢复外发");
  assert.equal(r2.applied.filter((a) => a.effect === "released").length, 0);

  // 只剩分项闸的情形：挂够 30 分钟 + 连续健康 → 自动放回
  const root2 = ws();
  const onlyProactive = assessDegradation({
    now: NOW,
    signals: { hallucination: { hits: [{ id: "AP-002" }, { id: "AP-009" }] }, competence: { toolCalls: 40, toolFailures: 2, deliveries: { total: 10, green: 9 } } },
  });
  assert.equal(onlyProactive.level, "degraded");
  assert.deepEqual(onlyProactive.actions.map((a) => a.action), ["pause-proactive"]);
  applyActions({ wsRoot: root2, assessment: onlyProactive, now: NOW, by: "degradation" });
  assert.equal(readPauseGate(root2).scopes.proactive, true);
  assert.equal(readPauseGate(root2).on, false);

  // 还没挂够 30 分钟 → 不解
  applyActions({ wsRoot: root2, assessment: assessDegradation({ now: NOW, signals: healthySignals() }), now: NOW + 60_000, by: "degradation" });
  assert.equal(readPauseGate(root2).scopes.proactive, true, "刚挂上就解会来回抖");

  // 挂够了 → 解，并留痕
  const r4 = applyActions({ wsRoot: root2, assessment: assessDegradation({ now: NOW, signals: healthySignals() }), now: NOW + AUTO_RELEASE_HOLD_MS + 60_000, by: "degradation" });
  assert.ok(r4.applied.some((a) => a.effect === "released" && a.scope === "proactive"));
  assert.equal(readPauseGate(root2).scopes.proactive, false);
  assert.ok(readPauseGate(root2).history.some((h) => h.on === false && h.scope === "proactive"));

  // 人手挂的（by:api）不自动解
  const root3 = ws();
  setPauseGate(root3, { on: true, reason: "人工停机", by: "api", action: "pause-proactive", scope: "proactive" });
  const r5 = applyActions({ wsRoot: root3, assessment: assessDegradation({ now: NOW, signals: healthySignals() }), now: NOW + AUTO_RELEASE_HOLD_MS + 1, by: "degradation" });
  assert.equal(readPauseGate(root3).scopes.proactive, true, "人挂的闸不该被系统悄悄解掉");
  assert.equal(r5.applied.filter((a) => a.effect === "released").length, 0);
});

// ───────────────────────── 五、闸 ─────────────────────────

test("闸：high 风险动作写入后 readPauseGate 为 on；非 high 动作写不进去", () => {
  const root = ws();
  assert.equal(readPauseGate(root).on, false, "没有文件=没暂停");
  assert.equal(isPaused(root, "media"), null);

  // high 风险 + 理由 → 写成功，全局和分项全停
  const ok = setPauseGate(root, { on: true, reason: "幻觉失控 + 模型连续 429", by: "test", action: "global-pause" });
  assert.equal(ok.ok, true);
  const gate = readPauseGate(root);
  assert.equal(gate.on, true);
  assert.equal(gate.scopes.proactive, true);
  assert.equal(gate.scopes.media, true);
  assert.equal(gate.reason, "幻觉失控 + 模型连续 429");
  assert.equal(gate.action, "global-pause");
  assert.ok(gate.at > 0);
  assert.ok(gate.history.length >= 1);
  assert.ok(fs.existsSync(path.join(root, PAUSE_REL)));
  assert.ok(isPaused(root, "media"), "全局停 → 分项也停");
  assert.ok(isPaused(root, "outbound") );

  // 低/中风险动作不能写全局闸
  for (const action of ["compress-session", "switch-model", "pause-proactive", "freeze-subagents", "text-only"]) {
    const r = setPauseGate(root, { on: true, reason: "试试", by: "test", action });
    assert.equal(r.ok, false, `${action} 不该能写全局闸`);
    assert.match(r.error, /high/);
  }
  // 不带动作 / 不带理由 → 都不行
  assert.equal(setPauseGate(root, { on: true, reason: "没动作", by: "test" }).ok, false);
  assert.equal(setPauseGate(root, { on: true, action: "global-pause", by: "test" }).ok, false);
  // 失败写入不改变现有状态
  assert.equal(readPauseGate(root).on, true);
  assert.equal(readPauseGate(root).action, "global-pause");
  // 只有 global-pause 在 high 名单里
  assert.deepEqual([...HIGH_RISK_ACTIONS], ["global-pause"]);
});

test("分项闸：pause-proactive 只停主动触达、text-only 只停媒体；解除要留痕", () => {
  const root = ws();
  assert.equal(setPauseGate(root, { on: true, reason: "幻觉多先闭嘴", by: "test", action: "pause-proactive", scope: "proactive" }).ok, true);
  let gate = readPauseGate(root);
  assert.equal(gate.on, false, "分项停不是全局停");
  assert.equal(gate.scopes.proactive, true);
  assert.equal(gate.scopes.media, false);
  assert.ok(isPaused(root, "proactive"));
  assert.equal(isPaused(root, "media"), null);

  assert.equal(setPauseGate(root, { on: true, reason: "模型不稳停出图", by: "test", action: "text-only", scope: "media" }).ok, true);
  gate = readPauseGate(root);
  assert.equal(gate.scopes.media, true);
  assert.ok(isPaused(root, "media"));

  // 分项闸只认自己的动作
  assert.equal(setPauseGate(root, { on: true, reason: "x", by: "t", action: "text-only", scope: "proactive" }).ok, false);

  // 解除
  const off = setPauseGate(root, { on: false, reason: "人看过了", by: "user", scope: "proactive" });
  assert.equal(off.ok, true);
  gate = readPauseGate(root);
  assert.equal(gate.scopes.proactive, false);
  assert.equal(gate.scopes.media, true, "解一个作用域不该顺手解另一个");
  assert.ok(gate.history.some((h) => h.on === false && h.scope === "proactive"));

  // 全局解除
  setPauseGate(root, { on: true, reason: "全线停", by: "test", action: "global-pause" });
  assert.equal(readPauseGate(root).on, true);
  assert.equal(setPauseGate(root, { on: false, reason: "查清了", by: "user" }).ok, true);
  gate = readPauseGate(root);
  assert.equal(gate.on, false);
  assert.equal(gate.scopes.media, false);
});

test("闸真的有人读：闸开 → proactive-policy hold、sendOut 只记不发", async () => {
  const root = ws();
  // 没闸：这一刻该发就发（21:00 不是死夜，没有配额/冷却阻碍）
  const open = decide({ now: NOW, candidates: [{ trigger: "mood_dip" }], state: { wsRoot: root } });
  assert.equal(open.action, "send");

  setPauseGate(root, { on: true, reason: "退化自救：幻觉高", by: "test", action: "global-pause" });
  const paused = decide({ now: NOW, candidates: [{ trigger: "mood_dip" }], state: { wsRoot: root } });
  assert.equal(paused.action, "hold", "闸开必须 hold");
  assert.equal(paused.reason, "global_pause");
  assert.equal(paused.pauseReason, "退化自救：幻觉高");
  assert.ok(paused.held.length >= 1);
  // 每个 trigger 都挡住（不是只挡一个 topic）
  for (const trigger of ["mood_dip", "late_night", "concern_scan", "long_silence", "positive_vibe", "open_loop"]) {
    assert.equal(decide({ now: NOW, candidates: [{ trigger }], state: { wsRoot: root } }).action, "hold", `${trigger} 也该 hold`);
  }
  // 分项闸同样生效
  const root2 = ws();
  setPauseGate(root2, { on: true, reason: "先别催", by: "test", action: "pause-proactive", scope: "proactive" });
  const held = decide({ now: NOW, candidates: [{ trigger: "mood_dip" }], state: { wsRoot: root2 } });
  assert.equal(held.action, "hold");
  assert.equal(held.reason, "proactive_paused");

  // 外发：闸开时一个通道都不该被调用，但账要记一条 paused
  let called = 0;
  const deps = { wechat: { notifyOwner: async () => { called += 1; return { failedText: 0 }; } } };
  const out = await sendOut({ wsRoot: root, text: "上线通知", deps });
  assert.equal(called, 0, "闸开不该真的发出去");
  assert.equal(out.ok, false);
  assert.equal(out.paused, true);
  assert.match(out.detail, /只记不发/);
  const ledger = readLedger(root);
  assert.equal(ledger.items[0].paused, true);
  assert.ok(ledger.items[0].at > 0);

  // 解闸后恢复正常发送
  setPauseGate(root, { on: false, reason: "查清了", by: "user" });
  const after = await sendOut({ wsRoot: root, text: "上线通知", deps });
  assert.equal(after.ok, true);
  assert.equal(called, 1);
});

// ───────────────────────── 六、接线静态断言 ─────────────────────────

test("接线：proactive-policy / outbound / notifier / 媒体入口 / server 路由都读了闸", () => {
  const policy = read("engine/proactive-policy.mjs");
  assert.match(policy, /import \{ readPauseGate \} from "\.\/degradation\.mjs"/);
  assert.match(policy, /pauseGate\.on \|\| pauseGate\.scopes\.proactive/, "decide 必须在最前面判闸");
  assert.match(policy, /reason: pauseGate\.on \? "global_pause" : "proactive_paused"/);

  const outbound = read("engine/outbound.mjs");
  assert.match(outbound, /import \{ readPauseGate \} from "\.\/degradation\.mjs"/);
  assert.match(outbound, /const gate = readPauseGate\(wsRoot\)/);
  assert.match(outbound, /if \(gate\.on\)/);
  assert.match(outbound, /paused: true/, "只记不发也要落账");

  const notifier = read("engine/notifier.mjs");
  assert.match(notifier, /import \{ readPauseGate \} from "\.\/degradation\.mjs"/);
  assert.match(notifier, /readPauseGate\(wsRoot\)/);
  assert.match(notifier, /result\.wechat = "paused"/);

  const media = read("engine/media/api.mjs");
  assert.match(media, /import \{ isPaused \} from "\.\.\/degradation\.mjs"/);
  assert.match(media, /isPaused\(WS_ROOT, "media"\)/);
  assert.match(media, /export async function generateMediaAsync[\s\S]{0,240}mediaPauseGate\(\)/, "生成入口要读闸");
  assert.match(media, /export async function generateImage[\s\S]{0,300}mediaPauseGate\(\)/);
  assert.match(media, /export async function startVideoJob[\s\S]{0,200}mediaPauseGate\(\)/);

  const server = read("server.mjs");
  assert.match(server, /\["GET", "\/api\/degradation"/);
  assert.match(server, /\["POST", "\/api\/degradation\/pause"/);
  assert.match(server, /degradationSnapshot\(WS_ROOT/);
  // 主动触达的两个调用点都要把 wsRoot 递进策略层（否则 decide 读不到闸）
  assert.match(read("engine/proactive-manager.mjs"), /state: \{ recent: journal, quietHours: isQuietHours\(now\), wsRoot \}/);
  assert.match(read("engine/companion-nudge.mjs"), /^\s+wsRoot,$/m);
});

// ───────────────────────── 七、读盘：台账 → signals → 评估 ─────────────────────────

test("collectSignals 从真实台账字段拼出五维（动作审计/交付门/反模式/每轮耗时/失败台账/子代理）", () => {
  const root = ws();
  const iso = (ms) => new Date(ms).toISOString();
  // 动作审计：3 次 before + 3 次 after（1 失败）
  const audit = [
    { at: NOW - 3 * MIN, tool: "write", phase: "before", argsHash: "a" },
    { at: NOW - 3 * MIN + 5, tool: "write", phase: "after", argsHash: "a", ok: true },
    { at: NOW - 2 * MIN, tool: "bash", phase: "before", argsHash: "b" },
    { at: NOW - 2 * MIN + 5, tool: "bash", phase: "after", argsHash: "b", ok: false, error: "boom" },
    { at: NOW - 1 * MIN, tool: "bash", phase: "before", argsHash: "c" },
    { at: NOW - 1 * MIN + 5, tool: "bash", phase: "after", argsHash: "c", ok: true },
  ].map((r) => JSON.stringify(r)).join("\n");
  write(root, path.join("记忆", "运行时", "动作审计.jsonl"), `${audit}\n`);
  // 交付门：2/3 GREEN
  write(root, path.join("记忆", "运行时", "交付门.json"), { items: [
    { at: NOW - 30 * MIN, verdict: "GREEN" }, { at: NOW - 20 * MIN, verdict: "GREEN" }, { at: NOW - 10 * MIN, verdict: "RED" },
  ] });
  // 反模式命中：一条幻觉类
  write(root, path.join("记忆", "运行时", "反模式命中.jsonl"), `${JSON.stringify({ id: "AP-002", evidence: "编了个数", at: iso(NOW - 5 * MIN) })}\n`);
  // 每轮耗时：lastCtx 占用 + 一轮慢
  write(root, path.join("记忆", "运行时", "每轮耗时.jsonl"), [
    { at: iso(NOW - 10 * MIN), totalMs: 5000, usage: { input: 30_000, output: 800, lastCtx: 30_000 } },
    { at: iso(NOW - 2 * MIN), totalMs: 90_000, usage: { input: 60_000, output: 400, lastCtx: 165_000 } },
  ].map((r) => JSON.stringify(r)).join("\n"));
  // 失败台账：一条 429、一条超时
  write(root, path.join("记忆", "运行时", "失败台账.json"), { v: 1, items: [
    { at: NOW - 20 * MIN, attempt: "调模型", why: "上游 429 rate limit", source: "tool" },
    { at: NOW - 15 * MIN, attempt: "出图", why: "请求超时 timeout", source: "tool" },
    { at: NOW - 14 * MIN, attempt: "改文件", why: "文件被占用", source: "manual" },   // other，不计分
  ] });
  // 子代理：一个跑超时的 running
  write(root, path.join("记忆", "运行时", "子代理.json"), { v: 1, items: [
    { id: "sub-1", status: "running", startedAt: iso(NOW - 40 * MIN), timeoutMs: 15 * MIN },
  ] });

  const signals = collectSignals(root, { now: NOW });
  assert.equal(signals.competence.toolCalls, 3);
  assert.equal(signals.competence.toolFailures, 1);
  assert.deepEqual(signals.competence.deliveries, { total: 3, green: 2 });
  assert.equal(signals.hallucination.hits.length, 1);
  assert.equal(signals.context.usedTokens, 165_000);
  assert.equal(signals.context.source, "lastCtx");
  assert.equal(signals.model.turns.total, 2);
  assert.equal(signals.model.turns.slow, 1);
  assert.equal(signals.model.failures.provider, 1);
  assert.equal(signals.model.failures.timeout, 1);
  assert.equal(signals.model.failures.other, 1);
  assert.equal(signals.subagents.items.length, 1);

  const a = assessWorkspace(root, { now: NOW });
  assert.equal(a.evaluated.length, 5, "六个台账都在，五维都该评上");
  assert.deepEqual(a.unevaluated, []);
  assert.ok(a.subscores.subagents.evidence.stalled === 1);
  assert.ok(a.score > 0.2 && a.score < 1, `实际 ${a.score}`);
  assert.ok(a.reasons.length >= 6);
  assert.equal(a.workspace, root);

  // 窗口由调用方给（models.json 的 contextWindow）→ 不再标 estimated，比例按真窗口算
  const estimated = a.subscores.contextPressure;
  assert.equal(estimated.evidence.estimated, true, "没给窗口时应标 estimated");
  const measured = assessWorkspace(root, { now: NOW, contextWindow: 200_000 });
  assert.equal(measured.subscores.contextPressure.evidence.estimated, false);
  assert.equal(measured.subscores.contextPressure.evidence.contextWindow, 200_000);
  assert.ok(Math.abs(measured.subscores.contextPressure.evidence.ratio - 165_000 / 200_000) < 1e-6);

  // 快照（GET /api/degradation 的返回体）形状
  const snap = degradationSnapshot(root, { now: NOW, limit: 5 });
  assert.equal(snap.ok, true);
  assert.equal(snap.assessment.v, 1);
  assert.equal(snap.gate.on, false);
  assert.equal(snap.ladder.length, 6);
  assert.deepEqual(snap.thresholds, THRESHOLDS);
  assert.ok(Array.isArray(snap.actions));
});

test("空工作区：没有台账 → 五维全 unevaluated、不编分、不报错", () => {
  const root = ws();
  const snap = degradationSnapshot(root, { now: NOW });
  assert.equal(snap.ok, true);
  assert.equal(snap.assessment.score, 0);
  assert.equal(snap.assessment.unevaluated.length, 5);
  assert.equal(snap.assessment.level, "healthy");
  assert.deepEqual(snap.assessment.actions, []);
  assert.equal(snap.gate.on, false);
  assert.equal(collectSignals(path.join(root, "not-exist"), { now: NOW }).competence, null);
});
