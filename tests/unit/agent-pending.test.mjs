// agent-pending 的纯函数逻辑
import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingKind, pendingOverview } from '../../engine/agent-pending.mjs';

const reg = list => ({ list: () => list });

test('未知工具名不冒充本机受限类', () => {
  assert.deepEqual(pendingKind('run_code'), { label: 'run_code', localOnly: false });
  assert.equal(pendingKind('persona-governance').localOnly, true);
  assert.equal(pendingKind('cultivation-policy').localOnly, false);
  assert.equal(pendingKind('maintenance').localOnly, true);
  assert.equal(pendingKind('').label, '确认');
});

test('聚合带出会话、类型名与批准能力，本地受限类远程不可批准', () => {
  const r = pendingOverview({
    registry: reg([
      { id: 'a1', sessionId: 's1', toolName: 'gene-governance', reason: '改基因', expiresAt: 200 },
      { id: 'a2', sessionId: 's2', toolName: 'cultivation-policy', reason: '开培养', expiresAt: 100 },
      { id: 'a3', sessionId: 's3', toolName: 'maintenance', reason: '申请超维', expiresAt: 300 },
      { id: '', sessionId: 's4', toolName: 'x' }, // 没有卡号：不可能是真实注册表产物，跳过
      null,
    ]),
    localApprovalOk: false,
  });
  assert.deepEqual(r.items.map(i => i.id), ['a2', 'a1', 'a3'], '最快过期排最前');
  const a2 = r.items.find(i => i.id === 'a2');
  const a1 = r.items.find(i => i.id === 'a1');
  const a3 = r.items.find(i => i.id === 'a3');
  assert.equal(a2.kind, '培养策略（一次性）');
  assert.equal(a2.canApprove, true, '培养策略会话确认不要求本机');
  assert.equal(a1.canApprove, false, '基因变更远程不可批准');
  assert.equal(a3.canApprove, false, '超维远程不可批准');
  assert.equal(r.canApproveLocally, false);
  assert.equal(r.count, 3);

  const local = pendingOverview({ registry: reg([{ id: 'b1', sessionId: 's1', toolName: 'computer-use', reason: 'x', expiresAt: 1 }]), localApprovalOk: true });
  assert.equal(local.items[0].canApprove, true);
});

test('缺行省注册表与坏注册表 fail-closed：空总览而不是炸', () => {
  assert.deepEqual(pendingOverview({}), { ok: true, canApproveLocally: false, count: 0, items: [] });
  assert.equal(pendingOverview({ registry: {} }).count, 0);
});
