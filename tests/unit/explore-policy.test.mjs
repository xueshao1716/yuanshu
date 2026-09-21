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
import { grant, revoke } from '../../engine/autonomy.mjs';
import { openTrace, addNode, closeTrace, loadTrace, listTraces, recordDelegation } from '../../engine/trace.mjs';

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
    if (i === succeedAt) {
      addNode(root, trace.id, { action: '独立验证', outcome: 'PASS', score: 1, cost: 0 });
      break;
    }
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
  let verifies = 0;
  const out = await runOnTheSpotFix({
    problem: '把那个偶发失败的用例稳下来',
    wsRoot: root,
    store: new Map(),
    runTurn: async (prompt = '') => {
      // 验证轮（engine/verifier.mjs）也要走同一个 runTurn：它必须拿到 verdict JSON
      if (/独立验证者/.test(prompt)) { verifies++; return '```json\n{"verdict":"PASS","evidence":"node --test → 12/12 pass"}\n```' }
      calls++;
      return calls < 3
        ? '```json\n{"status":"failed","evidence":"这次没成"}\n```'
        : '```json\n{"status":"done","evidence":"node --test → 12/12 pass"}\n```';
    },
  });
  assert.equal(calls, 3, '旋钮说再试 2 次，执行轮就该被调用 3 次');
  assert.equal(verifies, 1, '成功后要派一次独立验证');
  assert.equal(out.status, 'done');
  const traces = listTraces(root, { kind: 'fix-attempt' });
  assert.equal(traces.length, 1);
  const t = loadTrace(root, traces[0].id);
  // 3 个执行节点 + 1 个验证节点
  assert.equal(t.nodes.length, 4, '每次尝试都要单独落节点，验证也要落一条');
  assert.deepEqual(t.nodes.slice(0, 3).map((n) => n.outcome), ['failed', 'failed', 'done']);
  assert.equal(t.nodes[3].action, '独立验证');
  assert.equal(t.nodes[3].outcome, 'PASS');
  assert.equal(t.closed.score, 1);
});

test('端到端：同一目标的多次尝试落进同一棵树 → 回放选出赢家 → 授权状自决并改旋钮 → 可撤销', async () => {
  const root = tmp();
  // 同一段的 5 次重跑：都必须落进**同一棵树**（否则"该重试几次"没法比较——这是我在端到端证明里撞到的坑）
  for (const ok of [false, false, false, false, false]) {
    recordDelegation(root, { kind: 'story-video', task: '第 7 段 · 主角回头', durationMs: 2000, ok, digest: ok ? '有产出' : '' });
  }
  recordDelegation(root, { kind: 'story-video', task: '第 7 段 · 主角回头', durationMs: 2000, ok: false, digest: '' });
  const traces = listTraces(root, { limit: 20 }).map((t) => loadTrace(root, t.id));
  assert.equal(traces.length, 1, '同一目标的多次尝试必须在同一棵树里');
  assert.equal(traces[0].nodes.length, 6, '6 次尝试 = 6 个节点');

  // 再加一段"第二次就成"的分镜：这条会**否掉 no-retry**（它省成本但丢成绩）——
  // 只有两条形状凑在一起，"该重试几次"才有唯一答案。
  recordDelegation(root, { kind: 'story-image', task: '第 2 段 · 空镜', durationMs: 2000, ok: false, digest: '' });
  recordDelegation(root, { kind: 'story-image', task: '第 2 段 · 空镜', durationMs: 2000, ok: true, digest: '有产出' });
  const all = listTraces(root, { limit: 20 }).map((t) => loadTrace(root, t.id));
  assert.equal(all.length, 2, '不同目标 = 不同的树');

  // 现役设成过冲（再试 3 次）：在"怎么试都不成"的树上纯烧成本 → 更省的策略应该赢
  promoteExplorePolicy(root, 'recorded', { retryOnFailure: 3 });
  const ex = replayExploreAcross(all, { incumbentId: 'recorded', incumbent: { retryOnFailure: 3 }, candidates: exploreCandidates() });
  assert.ok(ex.winner, '应该能选出赢家（否则闭环没合上）');
  assert.equal(ex.table.find((t) => t.id === 'no-retry').decision, 'reject', '省成本但丢了第二次的成功 → 必须拒绝（赢家不可能更差）');
  assert.equal(ex.winner, 'retry-1');

  // 走授权状：这类满足"可回放 + 可回滚 + 不碰红线" → 自决上线（不是交给人）
  let applied = null;
  const auth = await grant(
    { kind: 'config', text: `探索策略从 recorded 换成 ${ex.winner}` },
    { replayable: true, episodes: ex.traces, noWorse: true, betterCount: 1, reversible: true, scope: 'config' },
    { wsRoot: root, previous: 'recorded', apply: async () => { applied = promoteExplorePolicy(root, ex.winner, exploreCandidates().find((c) => c.id === ex.winner)); return { undo: 'explore:recorded', ...applied } } },
  );
  assert.equal(auth.decided, true, '技术参数 + 有证据 + 可回滚 → 自己定，不该再来问人');
  assert.match(auth.human.what, /探索策略/);
  assert.equal(currentExplorePolicy(root).retryOnFailure, 1, '旋钮真的被改了');

  const rv = await revoke(root, { revert: async () => { fs.unlinkSync(explorePolicyPath(root)); return { reset: true } } });
  assert.equal(rv.ok, true);
  assert.equal(currentExplorePolicy(root).retryOnFailure, DEFAULT_EXPLORE_POLICY.retryOnFailure, '一键退回出厂默认');
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
