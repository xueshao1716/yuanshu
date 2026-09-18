// reconcileInstances 的单测：登记不许说谎
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileInstances } from '../../engine/runtime-registry.mjs';

test('谁在服务以"请求落在谁身上"为准，其余自称标残留（不删证据）', () => {
  const live = [
    { pid: 11428, version: '2.78.0', ownsPort: true },
    { pid: 53404, version: '2.77.0', ownsPort: true },   // 被强杀留下的残留自称
    { pid: 999, version: '2.78.0', ownsPort: false },
  ];
  const r = reconcileInstances(live, { servingPid: 11428 });
  assert.equal(r.owner, 11428);
  const byPid = Object.fromEntries(r.list.map((x) => [x.pid, x]));
  assert.equal(byPid[11428].ownsPort, true);
  assert.equal(byPid[11428].staleClaim, false);
  assert.equal(byPid[53404].ownsPort, false, '没在服务的不能继续声称持有端口');
  assert.equal(byPid[53404].staleClaim, true);
  assert.equal(byPid[53404].claim, true, '自称要留证据，不能悄悄抹掉');
  assert.deepEqual(r.staleClaims, [53404]);
  assert.match(r.note, /pid 11428/);
  assert.match(r.note, /残留/);
});

test('没有自称时如实说"没人自称持有端口"，不硬编一个', () => {
  const r = reconcileInstances([{ pid: 1, ownsPort: false }], { servingPid: 1 });
  assert.equal(r.owner, null);
  assert.deepEqual(r.staleClaims, []);
  assert.match(r.note, /没有心跳自称持有端口/);
});

test('空输入不炸', () => {
  const r = reconcileInstances(undefined, {});
  assert.deepEqual(r.list, []);
  assert.equal(r.owner, null);
});
