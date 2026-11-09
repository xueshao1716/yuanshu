// 退化自评的「自动执行 low」边界（2026-11-09，用户批准的边界）
//
// 钉住七件事：
//   ① 只执行 risk:'low'；text-only(medium) / global-pause(high) 永远只记 skipped:'requires-human'；
//   ② 每次调用最多执行一个动作（挂在 10 分钟循环上，靠 limit:1 防抖）；
//   ③ 同一条动作 30 分钟内不重复执行（读盘上的 by:'auto' 记录，重启也不重放）；
//   ④ 每次真执行都写 记忆/运行时/退化动作.jsonl，字段带 by:'auto' 与 trigger:{level,subscore}；
//   ⑤ 自动挂的分项闸能在 activeActions() / GET /api/degradation 里看到 by 与 since；
//   ⑥ 健康后 30 分钟仍自动放回（保留既有 releaseAutoPauses 规则，且只放自己挂的）；
//   ⑦ 静态断言：循环里确实调了 applyLowRiskOnly，且跳过 medium/high 的代码还在。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assessDegradation, applyLowRiskOnly, assessAndApplyLowRisk,
  activeActions, readActionLog, readPauseGate, setPauseGate, degradationSnapshot,
  ACTION_LOG_REL, AUTO_ACTION_COOLDOWN_MS, AUTO_RELEASE_HOLD_MS,
  HUMAN_ONLY_ACTIONS, GATE_BY_AUTO, AUTO_RISK,
} from "../../engine/degradation.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "deg-auto-"));
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const NOW = new Date(2026, 10, 9, 21, 0, 0, 0).getTime();
const MIN = 60 * 1000;
const logRows = (root) => {
  try { return fs.readFileSync(path.join(root, ACTION_LOG_REL), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};

// 五维都健康（全 evaluated）
const healthySignals = () => ({
  competence: { toolCalls: 40, toolFailures: 2, deliveries: { total: 10, green: 9 } },
  hallucination: { hits: [] },
  context: { usedTokens: 20_000, contextWindow: 200_000 },
  model: { failures: { provider: 0, timeout: 0, model: 0, other: 0 }, turns: { total: 20, slow: 0, empty: 0 } },
  subagents: { items: [{ id: "s1", status: "done", startedAt: new Date(NOW - 5 * MIN).toISOString() }], now: NOW },
});
const healthy = () => assessDegradation({ now: NOW, signals: healthySignals() });
// 上下文吃紧 + 幻觉两条 → 两个 low：compress-session / pause-proactive（degraded）
const twoLow = () => assessDegradation({
  now: NOW,
  signals: {
    ...healthySignals(),
    context: { usedTokens: 180_000, contextWindow: 200_000 },
    hallucination: { hits: [{ id: "AP-002", severity: "high" }, { id: "AP-009", severity: "high" }] },
  },
});
// 五维全坏 → 六个动作全出（含 medium 的 text-only、high 的 global-pause）
const critical = () => assessDegradation({
  now: NOW,
  signals: {
    competence: { toolCalls: 20, toolFailures: 16, deliveries: { total: 10, green: 3 } },
    hallucination: { hits: [{ id: "AP-002" }, { id: "AP-009" }, { id: "AP-012" }] },
    context: { usedTokens: 192_000, contextWindow: 200_000 },
    model: { failures: { provider: 3, timeout: 2, model: 0, other: 0 }, turns: { total: 20, slow: 3, empty: 2 } },
    subagents: { items: [{ id: "s1", status: "running", startedAt: new Date(NOW - 40 * MIN).toISOString(), timeoutMs: 15 * MIN }], now: NOW },
  },
});
/** 伪造一份评估（用来钉"就算上游把 global-pause 标成 low，也不许执行"）。 */
const forged = (actions, level = "critical") => ({
  level, score: 0.9, evaluated: [], unevaluated: [],
  subscores: { hallucination: { score: 1, evaluated: true, evidence: {} }, contextPressure: { score: 0.9, evaluated: true, evidence: {} } },
  actions,
});

// ───────────── 一、只跑 low，medium/high 一个字都不动 ─────────────

test("critical 全阶梯：只执行一个 low，text-only 与 global-pause 记 requires-human 且全局闸没被碰", () => {
  const root = ws();
  const a = critical();
  assert.deepEqual(a.actions.map((x) => x.action),
    ["compress-session", "switch-model", "pause-proactive", "freeze-subagents", "text-only", "global-pause"]);

  const r = applyLowRiskOnly({ wsRoot: root, assessment: a, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.level, "critical");
  assert.equal(r.executed.length, 1, "每次最多执行一个动作");
  assert.equal(r.executed[0].action, "compress-session");
  assert.equal(r.executed[0].risk, "low");
  assert.equal(r.executed[0].effect, "suggested", "压缩/切模型/冻结按仓库既有约定只落建议");

  // medium/high 全在待人工清单里，且带 skipped 标记
  const pending = r.pendingHuman.map((x) => x.action).sort();
  assert.deepEqual(pending, ["global-pause", "text-only"]);
  for (const p of r.pendingHuman) {
    assert.equal(p.skipped, "requires-human");
    assert.ok(["medium", "high"].includes(p.risk));
  }

  // 闸：一点都没被写（全局没开、媒体没停、主动也没停）
  const gate = readPauseGate(root);
  assert.equal(gate.on, false, "自动路径永远不写全局闸");
  assert.equal(gate.scopes.media, false, "text-only 是 medium，自动路径不许停媒体");
  assert.equal(gate.scopes.proactive, false, "这一轮只执行了 compress-session");

  // 落账：by:'auto' + trigger:{level,subscore}
  const rows = logRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].by, "auto");
  assert.equal(rows[0].trigger.level, "critical");
  assert.equal(rows[0].trigger.subscore.contextPressure, 1, "192k/200k 已紧到拉满");
  assert.equal(rows[0].trigger.subscore.hallucination, 1);
  assert.equal(rows[0].executed.length, 1);
  assert.equal(rows[0].pendingHuman.length, 2);
});

test("双保险：上游把 global-pause 谎报成 low，自动路径也不执行（按动作名硬拦）", () => {
  const root = ws();
  const r = applyLowRiskOnly({
    wsRoot: root, now: NOW,
    assessment: forged([
      { action: "global-pause", risk: "low", reversible: true, reason: "伪装成 low 的全局暂停" },
      { action: "text-only", risk: "low", reversible: true, reason: "伪装成 low 的只文字" },
    ]),
  });
  assert.equal(r.executed.length, 0, "这两个动作在自动路径里必须一个都不执行");
  assert.deepEqual(r.pendingHuman.map((x) => x.action).sort(), ["global-pause", "text-only"]);
  for (const p of r.pendingHuman) assert.equal(p.skipped, "requires-human");
  assert.equal(readPauseGate(root).on, false);
  assert.equal(readPauseGate(root).scopes.media, false);
  // HUMAN_ONLY_ACTIONS 是硬名单，不是配置项
  assert.deepEqual([...HUMAN_ONLY_ACTIONS], ["text-only", "global-pause"]);
});

// ───────────── 二、每轮最多一个 + 30 分钟不重复 ─────────────

test("防抖：一轮一个；同一条动作 30 分钟内不重复，过窗才再执行", () => {
  const root = ws();
  const a = twoLow();
  assert.deepEqual(a.actions.map((x) => x.action), ["compress-session", "pause-proactive"]);

  // 第 1 轮：compress-session（suggested）
  const r1 = applyLowRiskOnly({ wsRoot: root, assessment: a, now: NOW });
  assert.equal(r1.executed.length, 1);
  assert.equal(r1.executed[0].action, "compress-session");

  // 第 2 轮（1 分钟后）：compress-session 冷却中 → 换下一个 low
  const r2 = applyLowRiskOnly({ wsRoot: root, assessment: a, now: NOW + MIN });
  assert.equal(r2.executed.length, 1);
  assert.equal(r2.executed[0].action, "pause-proactive");
  assert.equal(r2.executed[0].effect, "paused");
  assert.ok(r2.skipped.some((s) => s.action === "compress-session" && s.skipped === "cooldown"));

  // 第 3 轮（2 分钟后）：两个都在冷却里 → 一个都不执行
  const r3 = applyLowRiskOnly({ wsRoot: root, assessment: a, now: NOW + 2 * MIN });
  assert.equal(r3.executed.length, 0);
  assert.equal(r3.skipped.length, 2);
  assert.equal(r3.recorded, false, "什么都没有发生就不许再刷一行账");

  // 过 30 分钟窗：compress-session 重新可执行
  const r4 = applyLowRiskOnly({ wsRoot: root, assessment: a, now: NOW + 2 * MIN + AUTO_ACTION_COOLDOWN_MS + 1 });
  assert.equal(r4.executed.length, 1);
  assert.equal(r4.executed[0].action, "compress-session");
});

test("落账去重：同一份待人工清单 30 分钟内只记一次（换清单才再记）", () => {
  const root = ws();
  const onlyHuman = forged([
    { action: "text-only", risk: "medium", reversible: true, reason: "模型稳定很差" },
    { action: "global-pause", risk: "high", reversible: true, reason: "幻觉 + 胜任都差" },
  ]);
  const r1 = applyLowRiskOnly({ wsRoot: root, assessment: onlyHuman, now: NOW });
  assert.equal(r1.recorded, true);
  assert.equal(logRows(root).length, 1);

  const r2 = applyLowRiskOnly({ wsRoot: root, assessment: onlyHuman, now: NOW + MIN });
  assert.equal(r2.recorded, false, "同一份待人工清单不该每 10 分钟写一行");
  assert.equal(logRows(root).length, 1);

  const r3 = applyLowRiskOnly({
    wsRoot: root, now: NOW + 2 * MIN,
    assessment: forged([{ action: "text-only", risk: "medium", reversible: true, reason: "只剩这一条" }]),
  });
  assert.equal(r3.recorded, true, "待人工清单变了要留痕");
  assert.equal(logRows(root).length, 2);
});

// ───────────── 三、可逆与可见 ─────────────

test("可见：自动挂的分项闸出现在 activeActions（by:'auto' + since），人手挂的是 human", () => {
  const root = ws();
  assert.deepEqual(activeActions(root), [], "没闸时是空数组");

  applyLowRiskOnly({ wsRoot: root, assessment: twoLow(), now: NOW });              // compress-session
  assert.deepEqual(activeActions(root), [], "只落建议的动作不该出现在 activeActions 里");

  applyLowRiskOnly({ wsRoot: root, assessment: twoLow(), now: NOW + MIN });       // pause-proactive → 写 proactive 分项闸
  const active = activeActions(root);
  assert.equal(active.length, 1);
  assert.equal(active[0].scope, "proactive");
  assert.equal(active[0].action, "pause-proactive");
  assert.equal(active[0].by, "auto", "看板要能看出是自动挂的");
  assert.equal(active[0].since, NOW + MIN, "since 是这条作用域被挂上的时间");
  assert.equal(active[0].autoReleasable, true);
  assert.match(active[0].reason, /幻觉|打扰/);
  // 闸文件的署名仍是 degradation:*，否则健康后回收会认不出来
  assert.equal(readPauseGate(root).by, GATE_BY_AUTO);
  assert.equal(readPauseGate(root).on, false);

  // 人手挂的：by:'human'，不给自动回收
  const root2 = ws();
  setPauseGate(root2, { on: true, reason: "我先手动停主动推送", by: "api", action: "pause-proactive", scope: "proactive", at: NOW });
  const human = activeActions(root2);
  assert.equal(human[0].by, "human");
  assert.equal(human[0].autoReleasable, false);
  assert.equal(human[0].since, NOW);

  // 快照（GET /api/degradation 的返回体）带 activeActions 与自动边界说明
  const snap = degradationSnapshot(root, { now: NOW + MIN, limit: 5 });
  assert.ok(Array.isArray(snap.activeActions));
  assert.equal(snap.activeActions[0].by, "auto");
  assert.equal(snap.auto.risk, "low");
  assert.deepEqual(snap.auto.humanOnly, ["text-only", "global-pause"]);
  assert.equal(snap.auto.actionCooldownMs, AUTO_ACTION_COOLDOWN_MS);
});

test("不覆盖人挂的闸：全局停/人挂的分项停时，自动路径跳过而不是改写署名", () => {
  // ① 人挂了全局暂停：自动路径一个动作都不执行，闸的署名/理由原样不动
  const root = ws();
  setPauseGate(root, { on: true, reason: "人工停机", by: "user", action: "global-pause", at: NOW });
  const r = applyLowRiskOnly({ wsRoot: root, assessment: twoLow(), now: NOW + MIN });
  assert.equal(r.executed.length, 0, "全局停时不该再往里写任何东西");
  assert.ok(r.skipped.some((s) => s.action === "pause-proactive" && s.skipped === "global-gate"));
  const gate = readPauseGate(root);
  assert.equal(gate.on, true);
  assert.equal(gate.by, "user", "人的署名不许被自动路径改掉");
  assert.equal(gate.reason, "人工停机");
  assert.equal(gate.at, NOW, "也不许刷新时间，否则看板会以为刚挂上");

  // ② 人挂了 proactive 分项：自动路径跳过 pause-proactive，但仍可以执行别的 low
  const root2 = ws();
  setPauseGate(root2, { on: true, reason: "我先手动停主动推送", by: "api", action: "pause-proactive", scope: "proactive", at: NOW });
  const r2 = applyLowRiskOnly({ wsRoot: root2, assessment: twoLow(), now: NOW + MIN });
  assert.deepEqual(r2.executed.map((x) => x.action), ["compress-session"]);
  assert.ok(r2.skipped.some((s) => s.action === "pause-proactive" && s.skipped === "already-paused"));
  const gate2 = readPauseGate(root2);
  assert.equal(gate2.by, "api");
  assert.equal(gate2.reason, "我先手动停主动推送");
  assert.equal(activeActions(root2)[0].by, "human");
});

test("可逆：连续 healthy 且挂够 30 分钟 → 自动放回；没挂够不解；人手闸不解", () => {
  const root = ws();
  applyLowRiskOnly({ wsRoot: root, assessment: twoLow(), now: NOW });                 // compress-session
  applyLowRiskOnly({ wsRoot: root, assessment: twoLow(), now: NOW + MIN });           // pause-proactive
  assert.equal(readPauseGate(root).scopes.proactive, true);

  // 健康但还没挂够 30 分钟（从挂上那一刻算）→ 不解
  const early = applyLowRiskOnly({ wsRoot: root, assessment: healthy(), now: NOW + 10 * MIN });
  assert.equal(early.executed.length, 0, "健康时不许执行任何动作");
  assert.equal(early.released.length, 0);
  assert.equal(readPauseGate(root).scopes.proactive, true, "刚挂上就解会来回抖");

  // 挂够了 → 放回，并留痕
  const later = applyLowRiskOnly({ wsRoot: root, assessment: healthy(), now: NOW + MIN + AUTO_RELEASE_HOLD_MS + 1 });
  assert.equal(later.released.length, 1);
  assert.equal(later.released[0].effect, "released");
  assert.equal(readPauseGate(root).scopes.proactive, false);
  assert.equal(later.recorded, true, "放回也要留一行账");
  const lastRow = logRows(root).pop();
  assert.equal(lastRow.by, "auto");
  assert.equal(lastRow.trigger.level, "healthy");

  // 人手挂的闸，健康也不动
  const root2 = ws();
  setPauseGate(root2, { on: true, reason: "人工停机", by: "user", action: "pause-proactive", scope: "proactive", at: NOW });
  const r = applyLowRiskOnly({ wsRoot: root2, assessment: healthy(), now: NOW + AUTO_RELEASE_HOLD_MS + 1 });
  assert.equal(r.released.length, 0);
  assert.equal(readPauseGate(root2).scopes.proactive, true, "人挂的闸不许被系统放回");
});

test("assessAndApplyLowRisk：读盘 → 评估 → 只跑 low（空工作区不炸、不编分）", () => {
  const root = ws();
  const { assessment, result } = assessAndApplyLowRisk(root, { now: NOW });
  assert.equal(assessment.unevaluated.length, 5);
  assert.equal(assessment.level, "healthy");
  assert.equal(result.ok, true);
  assert.equal(result.executed.length, 0);
  assert.deepEqual(result.pendingHuman, []);
  assert.equal(readActionLog(root, { limit: 5 }).length, 0);
});

// ───────────── 四、静态断言（接线不能被人悄悄拆掉）─────────────

test("接线：10 分钟循环里调了 applyLowRiskOnly(limit:1)，且 medium/high 的跳过代码还在", () => {
  const server = read("server.mjs");
  const jitterAt = server.indexOf("withJitter(10 * 60 * 1000");
  assert.ok(jitterAt > 0, "10 分钟循环（withJitter）必须在");
  const openAt = server.lastIndexOf("setInterval(() => {", jitterAt);
  assert.ok(openAt > 0, "10 分钟循环应该是一个 setInterval(() => { ... }) 回调");
  const body = server.slice(openAt, jitterAt);
  assert.match(body, /applyLowRiskOnly\(\{ wsRoot: WS_ROOT/, "循环里必须真的调 applyLowRiskOnly");
  assert.match(body, /limit: 1/, "每轮最多一个动作要写死在调用点");
  assert.match(body, /recordJobRun\(WS_ROOT, \{[\s\S]{0,80}jobId: "degradation-auto"/, "这一拍要记心跳（静默失败检测靠它）");

  const deg = read("engine/degradation.mjs");
  assert.match(deg, /export const HUMAN_ONLY_ACTIONS = Object\.freeze\(\["text-only", "global-pause"\]\)/, "硬名单必须在");
  assert.match(deg, /HUMAN_ONLY_ACTIONS\.includes\(act\.action\) \|\| risk !== AUTO_RISK/, "分拣时 medium/high 必须被拦下");
  assert.match(deg, /skipped: "requires-human"/, "跳过要留标记");
  assert.match(deg, /by: "auto"/, "落账必须是 by:'auto'");
  assert.match(deg, /const trigger = \{ level:/, "落账必须带 trigger:{level,subscore}");
  // 自动路径里不许出现写全局闸的调用
  const autoFn = deg.slice(deg.indexOf("export function applyLowRiskOnly"), deg.indexOf("export function assessAndApplyLowRisk"));
  assert.ok(!/scope: "global"/.test(autoFn), "自动路径不许写全局闸");
  assert.ok(!/action: "global-pause"/.test(autoFn), "自动路径不许主动点名 global-pause");
  assert.equal(AUTO_RISK, "low");
});
