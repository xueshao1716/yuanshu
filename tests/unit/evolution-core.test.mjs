// 进化基础设施 v0：统一事件流 / 提案状态机 / 能力画像（2026-11-02）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvent, readEvents, summarizeCapability, validateProposal, createProposal, transitionProposal, readProposals, lineageOf } from "../../engine/evolution/index.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "evocore-"));
const good = { agentId: "xiaoyu", target: "skill", targetId: "py", reason: "r", hypothesis: "h", parentVersion: "1.0.0", candidateVersion: "1.1.0", datasetVersion: "ds-1", evaluatorVersion: "ev-1", n: 20 };

test("事件流：只追加，按 kind/target 过滤", () => {
  const root = ws();
  assert.equal(appendEvent(root, { kind: "compare", target: "skill", targetId: "py", verdict: "keep" }).ok, true);
  appendEvent(root, { kind: "gate", verdict: "red" });
  appendEvent(root, { kind: "compare", target: "skill", targetId: "py", verdict: "rollback" });
  assert.equal(readEvents(root).length, 3);
  assert.equal(readEvents(root, { kind: "compare" }).length, 2);
  assert.equal(readEvents(root, { target: "skill" }).length, 2);
});

test("事件流：未知 kind 被拒", () => {
  const root = ws();
  assert.equal(appendEvent(root, { kind: "乱写" }).ok, false);
  assert.equal(readEvents(root).length, 0);
});

test("画像：样本够才出比率，不够返回 null", () => {
  const root = ws();
  for (const v of ["pass", "pass", "rollback", "pass"]) appendEvent(root, { kind: "task", taskType: "coding", verdict: v });
  const row = summarizeCapability(readEvents(root), { minN: 3 }).rows.find((r) => r.key === "task:coding");
  assert.equal(row.attempts, 4);
  assert.equal(row.successRate, 0.75);
  assert.equal(row.rollbackRate, 0.25);
  const root2 = ws();
  appendEvent(root2, { kind: "task", taskType: "writing", verdict: "pass" });
  assert.equal(summarizeCapability(readEvents(root2), { minN: 3 }).rows[0].successRate, null);
});

test("提案校验：缺数据集/评估器/n 一律拒绝", () => {
  const bad = validateProposal({ agentId: "x", target: "skill", targetId: "py", reason: "r", hypothesis: "h", parentVersion: "1", candidateVersion: "2" });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("datasetVersion")));
  assert.ok(bad.errors.some((e) => e.includes("n")));
  assert.equal(validateProposal(good).ok, true);
});

test("状态机：不能跳级；拒绝后不能复活", () => {
  const root = ws();
  const p = createProposal(root, good).proposal;
  assert.match(transitionProposal(root, p, "PROMOTED").reason, /不允许/);
  assert.equal(transitionProposal(root, p, "VALIDATING").ok, true);
  const p2 = createProposal(root, { ...good, targetId: "py2" }).proposal;
  const rej = transitionProposal(root, p2, "REJECTED");
  assert.equal(transitionProposal(root, rej.proposal, "VALIDATING").ok, false);
});

test("读提案：取最后状态", () => {
  const root = ws();
  const p = createProposal(root, good).proposal;
  transitionProposal(root, p, "VALIDATING");
  transitionProposal(root, { ...p, status: "VALIDATING" }, "EXPERIMENTING");
  const list = readProposals(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "EXPERIMENTING");
});

test('血缘：建提案时自动挂上同目标的最近事件', () => {
  const root = ws();
  const e1 = appendEvent(root, { kind: "compare", target: "skill", targetId: "py", verdict: "rollback" }).event;
  const e2 = appendEvent(root, { kind: "compare", target: "skill", targetId: "py", verdict: "rollback" }).event;
  const p = createProposal(root, good).proposal;
  assert.deepEqual(p.parentEventIds, [e1.id, e2.id]);
});

test('血缘：没有历史事件就是空数组（不编造）', () => {
  const root = ws();
  const p = createProposal(root, good).proposal;
  assert.deepEqual(p.parentEventIds, []);
});

test('血缘：lineageOf 按提案拉出父事件与提案事件', () => {
  const root = ws();
  const e = appendEvent(root, { kind: "compare", target: "skill", targetId: "py", verdict: "rollback" }).event;
  const p = createProposal(root, good).proposal;
  const chain = lineageOf(root, { proposalId: p.id });
  assert.equal(chain.ok, true);
  const ids = chain.events.map((x) => x.id);
  assert.ok(ids.includes(e.id), '父事件应在链上');
  assert.ok(chain.events.some((x) => x.kind === 'proposal'));
});

test('血缘：未知提案返回失败', () => {
  assert.equal(lineageOf(ws(), { proposalId: 'nope' }).ok, false);
});
