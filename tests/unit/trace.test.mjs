// 探索轨迹（engine/trace.mjs）：把"试了哪些路、花了多少、结果如何"记成**可回放的树**。
// 上一版做梦只能回放"选哪个技能"，因为探索过程没有结构化轨迹——这一版补上那一半。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openTrace, addNode, closeTrace, loadTrace, listTraces, replayTrace, nodeSucceeded,
  candidatePolicies, replayAcrossTraces, tracePath, recordDelegation,
} from '../../engine/trace.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-trace-'));

/** 一棵"试了三次、第三次成功"的探索树：每次都记了成本与结果。 */
function buildTrace(root, { thirdSucceeds = true } = {}) {
  const { trace } = openTrace(root, { kind: 'fix-attempt', goal: '把 X 修好' });
  addNode(root, trace.id, { action: 'try-A', input: '方案A', cost: 3, outcome: 'failed', score: 0 });
  addNode(root, trace.id, { action: 'try-B', input: '方案B', cost: 5, outcome: 'failed', score: 0 });
  addNode(root, trace.id, { action: 'try-C', input: '方案C', cost: 2, outcome: thirdSucceeds ? 'done' : 'failed', score: thirdSucceeds ? 1 : 0 });
  closeTrace(root, trace.id, { result: thirdSucceeds ? '修好了' : '没修好', score: thirdSucceeds ? 1 : 0, cost: 10 });
  return loadTrace(root, trace.id);
}

test('轨迹存取：开树、加节点、收尾；坏 id 不炸', () => {
  const root = tmp();
  const t = buildTrace(root);
  assert.equal(t.nodes.length, 3);
  assert.equal(t.closed.score, 1);
  assert.equal(t.nodes[2].parent, null, '没写 parent 就是根级');
  assert.equal(listTraces(root).length, 1);
  assert.equal(loadTrace(root, '不存在的 id'), null);
  assert.equal(addNode(root, '不存在的 id', { action: 'x' }).ok, false);
});

test('成功判定：outcome 白名单 + 有分且大于 0', () => {
  assert.equal(nodeSucceeded({ outcome: 'ok' }), true);
  assert.equal(nodeSucceeded({ outcome: 'done' }), true);
  assert.equal(nodeSucceeded({ outcome: 'kept' }), true);
  assert.equal(nodeSucceeded({ outcome: 'failed' }), false);
  assert.equal(nodeSucceeded({ outcome: 'blocked', score: 0 }), false);
  assert.equal(nodeSucceeded({ outcome: 'unknown', score: 0.5 }), true);
});

test('回放：同一棵树上，"试两次就停"省成本但会丢成绩——这就是要算的东西', () => {
  const root = tmp();
  const t = buildTrace(root);
  const recorded = replayTrace(t, { id: 'recorded' });
  assert.equal(recorded.nodes, 3);
  assert.equal(recorded.cost, 10);
  assert.equal(recorded.best, 1);

  const stop2 = replayTrace(t, { id: 'stop-after-2-fail', stopAfterFailures: 2 });
  assert.equal(stop2.stopped, 'stopAfterFailures');
  assert.equal(stop2.nodes, 2, '两次失败就停');
  assert.equal(stop2.cost, 8);
  assert.equal(stop2.best, null, '停了就丢掉了第三次的成功——回放器如实算出来');

  const max2 = replayTrace(t, { id: 'max-2', maxAttempts: 2 });
  assert.equal(max2.stopped, 'maxAttempts');
  assert.equal(max2.cost, 8);

  // 没修好的树：早停就是纯赚
  const bad = buildTrace(root, { thirdSucceeds: false });
  const r = replayTrace(bad, { id: 'stop-after-2-fail', stopAfterFailures: 2 });
  assert.equal(r.cost, 8);
  assert.equal(replayTrace(bad, { id: 'recorded' }).cost, 10);
  assert.equal(r.best, replayTrace(bad, { id: 'recorded' }).best, '成绩一样（都没有），但省了 2 个成本');
});

test('回放：只会算历史真走过的节点（没走过的分支不猜）', () => {
  const root = tmp();
  const t = buildTrace(root);
  const r = replayTrace(t, { id: 'bfs', order: 'bfs' });
  assert.equal(r.nodes, 3, '节点数不能凭空变多——做梦的边界就在这');
  assert.equal(r.cost, 10);
});

test('跨树做梦：现役在候选里；只有"都不更差且至少一棵更省"才算赢', () => {
  const root = tmp();
  const traces = [buildTrace(root, { thirdSucceeds: false }), buildTrace(root, { thirdSucceeds: false })];
  const r = replayAcrossTraces(traces, candidatePolicies(), { incumbentId: 'recorded' });
  assert.equal(r.ok, true);
  assert.equal(r.traces, 2);
  const byId = Object.fromEntries(r.table.map((t) => [t.id, t]));
  assert.equal(byId.recorded.decision, 'keep');
  // 两条轨迹都是"没修好"，早停纯赚成本。赢家按"省得最多"排（不是按候选表顺序）：
  // 停 1 次失败省得最多，所以它赢；停 2 次也算赢家之一。
  assert.equal(byId['stop-after-2-fail'].decision, 'promote');
  assert.equal(byId['stop-after-1-fail'].decision, 'promote');
  assert.match(byId['stop-after-2-fail'].reason, /更省成本/);
  assert.equal(r.winner, 'stop-after-1-fail', '省得最多的那个才是赢家，候选顺序不该决定结果');
  assert.match(r.proposal.text, /探索策略/);

  // 换成"第三次才成功"的轨迹：早停会丢成绩 → 必须被拒
  const root2 = tmp();
  const good = replayAcrossTraces([buildTrace(root2, { thirdSucceeds: true })], candidatePolicies(), { incumbentId: 'recorded' });
  const stop2 = good.table.find((t) => t.id === 'stop-after-2-fail');
  assert.equal(stop2.decision, 'reject');
  assert.match(stop2.reason, /丢了成绩|更差|成本/);
});

test('跨树做梦：没有轨迹就老实说没得做（别在没证据时改行为）', () => {
  const r = replayAcrossTraces([], candidatePolicies());
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有可用轨迹/);
  assert.equal(replayAcrossTraces([{ id: 'x', nodes: [] }]).ok, false);
});

test('轨迹文件落在工作区的 记忆/做梦/轨迹 下（不写进代码库）', () => {
  const root = tmp();
  const t = buildTrace(root);
  assert.ok(tracePath(root, t.id).startsWith(path.join(root, '记忆', '做梦', '轨迹')));
  assert.ok(fs.existsSync(tracePath(root, t.id)));
});

test('派活记一条：一次 delegate 就是一个节点（cost=秒，outcome=ok/error）', () => {
  const root = tmp();
  const ok = recordDelegation(root, { kind: 'delegate_task', task: '调研 A 方案', durationMs: 4200, ok: true, digest: '结论：A 可行' });
  assert.equal(ok.ok, true);
  const t = loadTrace(root, ok.id);
  assert.equal(t.kind, 'delegate_task');
  assert.equal(t.nodes[0].cost, 4.2);
  assert.equal(t.nodes[0].outcome, 'ok');
  assert.ok(t.nodes[0].score > 0, '有产出的派活分数应大于 0');
  assert.equal(t.closed.cost, 4.2);

  const bad = recordDelegation(root, { kind: 'delegate_task', task: '调研 B 方案', durationMs: 1000, ok: false, digest: '' });
  assert.equal(loadTrace(root, bad.id).nodes[0].score, 0, '空手而归 = 0 分');

  // 派活轨迹也能进回放（形状与当场修一致，回放器不用改）
  const r = replayAcrossTraces([loadTrace(root, ok.id), loadTrace(root, bad.id)], candidatePolicies(), { incumbentId: 'recorded' });
  assert.equal(r.ok, true);
  assert.equal(r.traces, 2);
  assert.equal(r.table.find((x) => x.id === 'recorded').decision, 'keep');
});
