// 脑区自调：步长/边界/冷却/开关/审计（2026-11-02）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeNudges, applyNudges, readAutoState, writeAutoState } from "../../engine/brain-auto.mjs";
import { appendEvent, readEvents } from "../../engine/evolution/index.mjs";
import { readRegions } from "../../engine/brain-regions.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "brainauto-"));
const ev = (verdict, taskType = "coding") => ({ kind: "task", taskType, verdict, at: new Date().toISOString() });
const base = { analysis: 0.5, planning: 0.5, verification: 0.5, memory: 0.5, tooling: 0.5, social: 0.5, coordination: 0.5, genesis: 0.5 };

test("样本不足：不动", () => {
  const out = computeNudges({ events: [ev("pass"), ev("pass")], weights: base });
  assert.equal(out.nudges.length, 0);
  assert.ok(out.skipped.includes("样本不足"));
});

test("失败率高：验证与分析各 +0.05，且最多两个", () => {
  const events = [ev("rollback"), ev("red"), ev("pass"), ev("pass"), ev("rollback"), ev("pass")];
  const out = computeNudges({ events, weights: base });
  assert.equal(out.nudges.length, 2);
  const ids = out.nudges.map((n) => n.id).sort();
  assert.deepEqual(ids, ["analysis", "verification"]);
  for (const n of out.nudges) assert.equal(n.delta, 0.05);
});

test("连续稳定：验证 -0.05（放宽换速度）", () => {
  const events = Array.from({ length: 12 }, () => ev("pass"));
  const out = computeNudges({ events, weights: base });
  const ver = out.nudges.find((n) => n.id === "verification");
  assert.ok(ver && ver.delta === -0.05);
});

test("冷却中：同一区 12 小时内不再调", () => {
  const events = [ev("rollback"), ev("pass"), ev("rollback"), ev("pass"), ev("rollback"), ev("pass")];
  const out = computeNudges({ events, weights: base, lastByRegion: { verification: Date.now() - 1000 } });
  assert.ok(!out.nudges.some((n) => n.id === "verification"));
  assert.ok(out.skipped.some((s) => s.includes("冷却")));
});

test("边界：到 0.95 就不再加", () => {
  const events = [ev("rollback"), ev("pass"), ev("rollback"), ev("pass"), ev("rollback"), ev("pass")];
  const out = computeNudges({ events, weights: { ...base, verification: 0.95, analysis: 0.95 } });
  assert.equal(out.nudges.length, 0);
});

test("applyNudges：写脑区 + 写 observation 事件", () => {
  const root = ws();
  for (const v of ["rollback", "pass", "rollback", "pass", "rollback", "pass"]) appendEvent(root, { kind: "task", taskType: "coding", verdict: v });
  const out = applyNudges(root, { now: Date.now() });
  assert.equal(out.ok, true);
  assert.ok(out.applied.length >= 1);
  const { weights } = readRegions(root);
  assert.ok(weights.verification > 0.5);
  const obs = readEvents(root, { kind: "observation" });
  assert.equal(obs.length, out.applied.length);
  assert.ok(obs.every((e) => e.by === "brain-auto" && e.target === "brain"));
});

test("开关关掉后不再调", () => {
  const root = ws();
  writeAutoState(root, { on: false });
  for (const v of ["rollback", "pass", "rollback", "pass", "rollback", "pass"]) appendEvent(root, { kind: "task", taskType: "coding", verdict: v });
  const out = applyNudges(root, { now: Date.now() });
  assert.equal(out.ok, true);
  assert.deepEqual(out.applied, []);
  assert.ok(out.skipped.includes("自调已关闭"));
  assert.equal(readAutoState(root).on, false);
});
