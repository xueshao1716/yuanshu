// 探索策略旋钮（engine/explore-policy.mjs）+ 当场修真的按它重试 —— 闭环的最后一环。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_EXPLORE_POLICY, currentExplorePolicy, promoteExplorePolicy, resetExplorePolicy,
  exploreCandidates, replayExplore, replayExploreAcross, explorePolicyPath,
} from '../../engine/explore-policy.mjs';
import { runOnTheSpotFix } from '../../engine/reflection-exec.mjs';
import { openTrace, addNode, closeTrace, loadTrace, listTraces } from '../../engine/trace.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-explore-'));

test('旋钮：出厂默认 → 存档覆盖 → 退回默认（退回只改存档，不动源码）', () => {
  const root = tmp();
  assert.equal(currentExplorePolicy(root).retryOnFailure, DEFAULT_EXPLORE_POLICY.retryOnFailure);
  const p = promoteExplorePolicy(root, 'retry-2', { retryOnFailure: 2 });
  assert.equal(p.ok, true);
  assert.equal(currentExplorePolicy(root).retryOnFailure, 2);
  assert.ok(explorePolicyPath(root).includes(path.join('记忆', '做梦')));
  const back = resetExplorePolicy(root);
  assert.equal(back.policy.retryOnFailure, DEFAULT_EXPLORE_POLICY.retryOnFailure);
  assert.equal(currentExplorePolicy(root).retryOnFailure, DEFAULT_EXPLORE_POLICY.retryOnFailure);
});

/** 一棵"试了 attempts 次"的轨迹：succeedAt=第几次成功（0 = 怎么试都不成）。 */
function fixTrace(root, { succeedAt, attempts = 3 }) {
  const { trace } = openTrace(root, { kind: 'fix-attempt', goal: '修 X' });
  for (let i = 1; i <= attempts; i++) {
    addNode(root, trace.id, { action: `执行轮·${i}`, cost: 2, outcome: i === succeedAt ? 'done' : 'failed', score: i === succeedAt ? 1 : 0 });
  }
  closeTrace(root, trace.id, { score: succeedAt ? 1 : 0, cost: attempts * 2 });
  return loadTrace(root, trace.id);
}

test('回放：试几次就够——第 3 次才成功时，no-retry 丢成绩、retry-2 刚好拿到', () => {
  const root = tmp();
  const t = fixTrace(root, { succeedAt: 3 });
  assert.equal(replayExplore(t, { id: 'no-retry', retryOnFailure: 0 }).score, 0);
  assert.equal(replayExplore(t, { id: 'retry-1', retryOnFailure: 1 }).score, 0);
  const r2 = replayExplore(t, { id: 'retry-2', retryOnFailure: 2 });
  assert.equal(r2.score, 1);
  assert.equal(r2.attempts, 3);
  assert.equal(r2.cost, 6);
});

test('跨轨迹：现役在候选里；只有"都不更差且至少一条更省"才算赢', () => {
  const root = tmp();
  // 三条轨迹：第 1 次就成（多试是浪费）、第 3 次才成（少试会丢成绩）、怎么试都不成（多试纯烧成本）
  const quick = fixTrace(root, { succeedAt: 1 });
  const slow = fixTrace(root, { succeedAt: 3 });
  const hopeless = fixTrace(root, { succeedAt: 0, attempts: 5 });

  // 现役 = retry-2：no-retry 会在 slow 上丢成绩 → 必须 reject
  const r1 = replayExploreAcross([quick, slow], { incumbentId: 'recorded', incumbent: { retryOnFailure: 2 } });
  const noRetry = r1.table.find((t) => t.id === 'no-retry');
  assert.equal(noRetry.decision, 'reject');
  assert.match(noRetry.reason, /丢了成绩|更多成本/);
  assert.equal(r1.table.find((t) => t.id === 'recorded').decision, 'keep');

  // 现役 = retry-3（过冲）：在"怎么试都不成"那条上多烧一次成本，而成绩一样（都是 0）
  //   → retry-2 每条都不更差、且在那条上更省 → 应该赢。
  //   注意 quick/slow 上两者成本相同：因为**一成功就停**，过冲只在"永远不成功"时才真花钱。
  const r2 = replayExploreAcross([quick, slow, hopeless], { incumbentId: 'recorded', incumbent: { retryOnFailure: 3 }, candidates: exploreCandidates() });
  assert.equal(r2.table.find((t) => t.id === 'retry-2').decision, 'promote');
  assert.equal(r2.winner, 'retry-2');
  assert.match(r2.proposal.text, /探索策略/);
});

test('没有轨迹时老实说没得做', () => {
  const r = replayExploreAcross([], {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有可用轨迹/);
});

test('当场修真的按旋钮重试：失败两次、第三次成功 → 轨迹里 3 个节点', async () => {
  const root = tmp();
  promoteExplorePolicy(root, 'retry-2', { retryOnFailure: 2 });
  let calls = 0;
  const out = await runOnTheSpotFix({
    problem: '把那个偶发失败的用例稳下来',
    wsRoot: root,
    store: new Map(),
    runTurn: async () => {
      calls++;
      return calls < 3
        ? '```json\n{"status":"failed","evidence":"这次没成"}\n```'
        : '```json\n{"status":"done","evidence":"node --test → 12/12 pass"}\n```';
    },
  });
  assert.equal(calls, 3, '旋钮说再试 2 次，就该被调用 3 次');
  assert.equal(out.status, 'done');
  const traces = listTraces(root, { kind: 'fix-attempt' });
  assert.equal(traces.length, 1);
  const t = loadTrace(root, traces[0].id);
  assert.equal(t.nodes.length, 3, '每次尝试都要单独落节点（否则"试几次"没法回放）');
  assert.deepEqual(t.nodes.map((n) => n.outcome), ['failed', 'failed', 'done']);
  assert.equal(t.closed.score, 1);
});

test('旋钮设为 0 时不再重试（省成本的那一侧也要真的生效）', async () => {
  const root = tmp();
  promoteExplorePolicy(root, 'no-retry', { retryOnFailure: 0 });
  let calls = 0;
  const out = await runOnTheSpotFix({
    problem: '把那个偶发失败的用例稳下来',
    wsRoot: root, store: new Map(),
    runTurn: async () => { calls++; return '```json\n{"status":"blocked","evidence":"缺 X"}\n```' },
  });
  assert.equal(calls, 1);
  assert.equal(out.status, 'blocked');
  assert.equal(loadTrace(root, listTraces(root)[0].id).nodes.length, 1);
});
