import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPendingApi } from '../../engine/pending-api.mjs';
import { createRunApi } from '../../engine/run-api.mjs';
import { newRecoveryPolicy } from '../../engine/run-recovery.mjs';
const mod = await import('../../engine/team-general-delivery.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
async function fixture(t) {
  assert.equal(typeof mod.stageGeneralTeamDelivery, 'function', 'general team must submit a real review proposal');
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-general-delivery-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const run = { id: 'parent', sessionId: 'session', backgroundRecovery: newRecoveryPolicy(wsRoot) };
  const delivery = await mod.stageGeneralTeamDelivery({ wsRoot, runId: run.id, sessionId: run.sessionId, deliveryId: 'delivery-1',
    content: '# 完整草稿\n0—3秒；口播：“先看价格。”\n', children: [
      { id: 'c1', label: 'IDEA', done: true }, { id: 'c2', label: 'CHALLENGE', done: true },
      { id: 'c3', label: 'EXEC', done: true }, { id: 'c4', label: 'REVIEW', done: true },
    ], verdict: { pass: true, issues: [] } });
  const events = [{ type: 'artifact_created', data: { delivery } }];
  const read = () => mod.readGeneralTeamDeliveries({ wsRoot, run, events })[0];
  const api = createPendingApi({ wsRoot, json: (_, status, body) => ({ status, ...body }) });
  return { wsRoot, run, delivery, events, read, api };
}

test('model review creates only a draft; human acceptance binds to the actual current artifact', async t => {
  const f = await fixture(t);
  assert.equal(f.read().decision, 'awaiting_acceptance');
  assert.equal(f.read().acceptance.status, 'pending');
  assert.equal(fs.existsSync(path.join(f.wsRoot, f.delivery.target)), false);
  assert.equal((await f.api.accept(null, f.delivery.proposalId)).status, 200);
  assert.equal(f.read().decision, 'ready_to_publish');
  fs.writeFileSync(path.join(f.wsRoot, f.delivery.target), '人工修订');
  assert.equal(f.read().decision, 'acceptance_stale');
});

test('edited draft or evidence never inherits old successful verification', async t => {
  const f = await fixture(t);
  const draft = path.join(f.wsRoot, f.delivery.draft);
  const original = fs.readFileSync(draft);
  fs.writeFileSync(draft, 'new draft');
  assert.equal(f.read().decision, 'unverified');
  fs.writeFileSync(draft, original);
  fs.writeFileSync(path.join(f.wsRoot, f.delivery.evidencePath), '{}');
  assert.equal(f.read().decision, 'unverified');
});

test('delivery observation is run and session bound and rejection is not approval', async t => {
  const f = await fixture(t);
  assert.deepEqual(mod.readGeneralTeamDeliveries({ ...f, run: { ...f.run, sessionId: 'other' } }), []);
  assert.deepEqual(mod.readGeneralTeamDeliveries({ ...f, run: { ...f.run, id: 'other' } }), []);
  await f.api.reject(null, f.delivery.proposalId, { reason: '需要修改' });
  assert.equal(f.read().decision, 'rejected');
});

test('delivery observation rejects changed or unknown workspace scope', async t => {
  const f = await fixture(t);
  for (const scope of [path.join(f.wsRoot, 'other-project'), undefined]) {
    const run = { ...f.run, backgroundRecovery: scope ? newRecoveryPolicy(scope) : undefined };
    assert.deepEqual(mod.readGeneralTeamDeliveries({ ...f, run }), [], 'must not adopt an unbound delivery');
  }
  if (process.platform === 'win32') {
    assert.equal(mod.readGeneralTeamDeliveries({ ...f, wsRoot: f.wsRoot.toUpperCase() })[0].decision, 'awaiting_acceptance');
  }
});

test('missing review queue preserves draft but cannot claim awaiting acceptance', async t => {
  const f = await fixture(t);
  fs.rmSync(path.join(f.wsRoot, '工程/待审'), { recursive: true });
  fs.writeFileSync(path.join(f.wsRoot, '工程/待审'), 'blocked directory');
  const next = await mod.stageGeneralTeamDelivery({ wsRoot: f.wsRoot, runId: 'parent', sessionId: 'session', deliveryId: 'delivery-2',
    content: '草稿', children: f.delivery.evidence.children, verdict: { pass: true, issues: [] } });
  assert.equal(next.status, 'submission_failed');
  assert.equal(fs.readFileSync(path.join(f.wsRoot, next.draft), 'utf8'), '草稿');
});

test('run overview and detail refresh acceptance even without a new run event', async t => {
  const f = await fixture(t);
  f.run.status = 'completed';
  const api = createRunApi({ manager: { list: () => [f.run], get: () => f.run, readAfter: () => f.events },
    json: (_, status, body) => ({ status, ...body }),
    readDeliveries: (run, events) => mod.readGeneralTeamDeliveries({ wsRoot: f.wsRoot, run, events }) });
  assert.equal((await api.get(null, f.run.id)).deliveries?.[0]?.decision, 'awaiting_acceptance');
  await f.api.accept(null, f.delivery.proposalId);
  assert.equal((await api.overview(null)).recent[0].deliveries?.[0]?.decision, 'ready_to_publish');
  fs.writeFileSync(path.join(f.wsRoot, f.delivery.target), 'changed');
  assert.equal((await api.get(null, f.run.id)).deliveries?.[0]?.decision, 'acceptance_stale');
});

test('repeating completed staging does not overwrite drafts or duplicate proposals', async t => {
  const f = await fixture(t);
  const repeat = () => mod.stageGeneralTeamDelivery({ wsRoot: f.wsRoot, runId: f.run.id, sessionId: f.run.sessionId,
    deliveryId: f.delivery.deliveryId, content: fs.readFileSync(path.join(f.wsRoot, f.delivery.draft), 'utf8'),
    children: f.delivery.evidence.children, verdict: { pass: true, issues: [] } });
  assert.equal((await repeat()).proposalId, f.delivery.proposalId);
  assert.equal(fs.readdirSync(path.join(f.wsRoot, '工程/待审')).length, 1);
  fs.writeFileSync(path.join(f.wsRoot, f.delivery.draft), 'user edited');
  await assert.rejects(repeat(), /已经变化/);
});

test('repeating staging refuses altered manifest paths, evidence or invented status', async t => {
  const f = await fixture(t);
  const file = path.join(f.wsRoot, f.delivery.evidencePath);
  const repeat = () => mod.stageGeneralTeamDelivery({ wsRoot: f.wsRoot, runId: f.run.id, sessionId: f.run.sessionId,
    deliveryId: f.delivery.deliveryId, content: fs.readFileSync(path.join(f.wsRoot, f.delivery.draft), 'utf8'),
    children: f.delivery.evidence.children, verdict: { pass: true, issues: [] } });
  for (const change of [
    { target: '工程/another.md' }, { profile: 'other' }, { deliveryId: 'other' }, { status: 'accepted' },
    { evidence: { ...f.delivery.evidence, passed: false } }, { proposalId: null },
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...f.delivery, ...change }));
    await assert.rejects(repeat(), /已经变化/, JSON.stringify(change));
  }
  assert.equal(fs.readdirSync(path.join(f.wsRoot, '工程/待审')).length, 1);
});

test('linked evidence and unbound paths fail closed', async t => {
  const f = await fixture(t);
  assert.deepEqual(mod.readGeneralTeamDeliveries({ ...f, events: [{ type: 'artifact_created', data: { delivery: { ...f.delivery, draft: '工程/other.md' } } }] }), []);
  fs.linkSync(path.join(f.wsRoot, f.delivery.evidencePath), path.join(f.wsRoot, 'evidence-link'));
  assert.equal(f.read().decision, 'unverified');
});

test('chat status exposes acceptance without approving or claiming media validation', () => {
  const file = new URL('../../frontend/src/components/TeamDeliveryStatus.tsx', import.meta.url);
  assert.ok(fs.existsSync(file), 'chat must show live review state');
  const source = fs.readFileSync(file, 'utf8');
  for (const text of ['awaiting_acceptance', 'ready_to_publish', 'acceptance_stale', 'submission_failed', '#/review', '仅文本流程']) assert.ok(source.includes(text), text);
  assert.ok(!source.includes('PendingApi.accept'));
  assert.ok(source.includes('downloadApiFile('), 'delivery downloads must use the authenticated download helper');
  assert.ok(source.includes('role="alert"'), 'download failures must be visible');
  assert.ok(fs.readFileSync(new URL('../../frontend/src/components/ChatRunStatus.tsx', import.meta.url), 'utf8').includes('<TeamDeliveryStatus'));
  assert.ok(fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8').includes('readDeliveries:'));
});
