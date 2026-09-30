import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {controlFixture, draft} from '../helpers/cultivation-fixture.mjs';

async function projection(store) {
  const url = new URL('../../engine/cultivation/projection.mjs', import.meta.url);
  assert.ok(fs.existsSync(url), 'read-only projection must be implemented');
  return (await import(url)).createCultivationProjection({store});
}
test('read-only empty overview exposes unavailable execution and unknown usage without writes', async t => {
  const f = await controlFixture(t), p = await projection(f.store);
  assert.equal(p.overview().state, 'waiting_for_design');
  assert.equal(p.overview().executorAvailable, false);
  assert.equal(p.overview().usage, null);
  assert.equal(p.overview().observations, 'not_observed');
  assert.equal(f.store.read('control').revision, 0);
  assert.deepEqual(p.list('agents').items, []);
  assert.throws(() => p.list('agents', {limit: 51}), /invalid_pagination/);
  assert.throws(() => p.list('agents', {cursor: 'junk'}), /invalid_cursor/);
  assert.equal(p.list('runs').supported, false);
});
test('stable bounded cursor rejects stale revisions, foreign collection and foreign workspace', async t => {
  const f = await controlFixture(t);
  for (let i = 0; i < 3; i++) await f.execute(f.command('design.submit', {design: draft()}), 'mother');
  const p = await projection(f.store), first = p.list('designs', {limit: 2});
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const next = p.list('designs', {limit: 2, cursor: first.nextCursor});
  assert.equal(next.items.length, 1); assert.equal(next.nextCursor, null);
  assert.notEqual(first.items[0].id, next.items[0].id);
  assert.throws(() => p.list('agents', {cursor: first.nextCursor}), /invalid_cursor/);
  const other = await controlFixture(t), otherProjection = await projection(other.store);
  assert.throws(() => otherProjection.list('designs', {cursor: first.nextCursor}), /invalid_cursor/);
  await f.execute(f.command('design.submit', {design: draft()}), 'mother');
  assert.throws(() => p.list('designs', {cursor: first.nextCursor}), /cursor_stale/);
});
test('cache avoids re-reading unchanged control but corruption never returns a stale success', async t => {
  const f = await controlFixture(t); await f.register();
  let reads = 0;
  const store = {...f.store, read: scope => {reads++; return f.store.read(scope);}};
  const p = await projection(store), one = p.list('agents');
  one.items[0].status = 'mutated';
  assert.equal(p.list('agents').items[0].status, 'ready');
  assert.equal(reads, 1);
  const file = path.join(f.root, '工程', '智能体培养', 'control.json');
  fs.writeFileSync(file, '{broken fixture');
  assert.throws(() => p.overview(), /state_unreadable/);
  assert.throws(() => p.overview(), /state_unreadable/);
});
test('agent detail separates initialization from authoritative pause and adopted design', async t => {
  const f = await controlFixture(t), {agentId, designId} = await f.register();
  const p = await projection(f.store);
  const row = p.detail(agentId);
  assert.equal(row.initialization, 'complete');
  assert.equal(row.design.id, designId);
  await f.execute(f.command('agent.pause', {agentId}));
  assert.equal(p.detail(agentId).agent.status, 'paused');
  assert.equal(p.detail(agentId).agent.cancellation, 'pending_confirmation');
  assert.throws(() => p.detail('../mother'), /invalid_scope/);
});

test('removal of an observed control file never projects a fresh empty success', async t => {
  const f = await controlFixture(t); await f.register();
  const p = await projection(f.store);
  assert.equal(p.overview().agentCount, 1);
  fs.unlinkSync(path.join(f.root, '工程', '智能体培养', 'control.json'));
  assert.throws(() => p.overview(), /state_unreadable/);
  assert.throws(() => p.list('agents'), /state_unreadable/);
});
