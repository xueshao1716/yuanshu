import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPendingApi } from '../../engine/pending-api.mjs';
import { stageTeamDraft } from '../../scripts/team-draft-delivery.mjs';

const module = await import('../../engine/team-acceptance.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
const resolve = (...args) => {
  assert.equal(typeof module.resolveTeamAcceptance, 'function', 'live acceptance resolver must exist');
  return module.resolveTeamAcceptance(...args);
};
async function fixture(t) {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-acceptance-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const api = createPendingApi({ wsRoot, json: (_, status, body) => ({ status, ...body }) });
  const runId = 'fixture-run';
  const delivery = await stageTeamDraft({ wsRoot, runId, content: '# 草稿\n待人工验收', eligible: true,
    submit: body => api.create(null, body) });
  const run = { runId, delivery };
  const proposal = path.join(wsRoot, `工程/待审/${delivery.proposalId}.json`);
  const edit = fields => fs.writeFileSync(proposal, JSON.stringify({ ...JSON.parse(fs.readFileSync(proposal)), ...fields }));
  return { wsRoot, api, run, proposal, edit, read: () => resolve({ wsRoot, run }) };
}

test('reads pending then accepted from real review flow without mutating snapshot or records', async t => {
  const f = await fixture(t);
  const snapshot = JSON.stringify(f.run);
  const before = fs.readFileSync(f.proposal, 'utf8');
  const pending = f.read();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.proposalId, f.run.delivery.proposalId);
  assert.equal('content' in pending, false);
  assert.ok(Number.isFinite(Date.parse(pending.checkedAt)));
  assert.equal(fs.readFileSync(f.proposal, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.wsRoot, f.run.delivery.target)), false);
  assert.equal((await f.api.accept(null, f.run.delivery.proposalId)).status, 200);
  assert.equal(f.read().status, 'accepted');
  assert.equal(JSON.stringify(f.run), snapshot);
});

test('rejection does not create a delivered file', async t => {
  const f = await fixture(t);
  await f.api.reject(null, f.run.delivery.proposalId, { reason: '请修改' });
  assert.equal(f.read().status, 'rejected');
  assert.equal(fs.existsSync(path.join(f.wsRoot, f.run.delivery.target)), false);
});

for (const status of ['applying', 'needs_recovery']) test(`exposes ${status} without implying delivery`, async t => {
  const f = await fixture(t); f.edit({ status });
  assert.equal(f.read().status, status);
});

test('accepted target changed or deleted is no longer confirmed delivery', async t => {
  const f = await fixture(t);
  await f.api.accept(null, f.run.delivery.proposalId);
  const target = path.join(f.wsRoot, f.run.delivery.target);
  fs.writeFileSync(target, 'revised or rolled back');
  assert.equal(f.read().status, 'target_changed');
  fs.unlinkSync(target);
  assert.equal(f.read().status, 'target_missing');
});

test('missing proposal is explicit; malformed records fail closed', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.proposal, '{broken');
  assert.equal(f.read().status, 'unknown');
  fs.unlinkSync(f.proposal);
  assert.equal(f.read().status, 'record_missing');
});

for (const fields of [ { id: 'pwrong' }, { target: '工程/other.md' }, { content: 'unrelated' },
  { status: 'done' }, { content: null }, { status: 'accepted', decidedAt: null } ]) {
  test(`rejects inconsistent proposal ${JSON.stringify(fields)}`, async t => {
    const f = await fixture(t); f.edit(fields);
    assert.equal(f.read().status, 'unknown');
  });
}

for (const field of ['runId', 'proposalId', 'target', 'draft']) test(`rejects invalid snapshot ${field}`, async t => {
  const f = await fixture(t);
  if (field === 'runId') f.run.runId = '../escape';
  else f.run.delivery[field] = '../../escape';
  assert.equal(f.read().status, 'unknown');
});

test('no live acceptance inferred for old snapshots or failed submission', async t => {
  const f = await fixture(t);
  for (const run of [null, {}, { delivery: { status: 'quality_failed' } }, { delivery: { status: 'submission_failed' } }]) {
    assert.equal(resolve({ wsRoot: f.wsRoot, run }), null);
  }
});

for (const field of ['draft', 'target', 'proposal']) test(`does not follow hardlinked ${field}`, async t => {
  const f = await fixture(t);
  await f.api.accept(null, f.run.delivery.proposalId);
  const file = field === 'proposal' ? f.proposal : path.join(f.wsRoot, f.run.delivery[field]);
  fs.linkSync(file, path.join(f.wsRoot, 'linked-copy'));
  assert.equal(f.read().status, 'unknown');
});

test('oversized record and draft fail closed before reading unbounded content', async t => {
  const f = await fixture(t);
  const original = fs.readFileSync(f.proposal);
  fs.writeFileSync(f.proposal, ' '.repeat(16_000_001));
  assert.equal(f.read().status, 'unknown');
  fs.writeFileSync(f.proposal, original);
  fs.writeFileSync(path.join(f.wsRoot, f.run.delivery.draft), 'a'.repeat(2_000_001));
  assert.equal(f.read().status, 'unknown');
});

test('server and UI wire a separate live result, not an overwritten snapshot', () => {
  const read = p => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  assert.ok(read('server.mjs').includes('["GET", "/api/team/run", (res) => teamRunRead(res)]'));
  assert.ok(read('engine/team-run-read.mjs').includes('acceptance: resolveTeamAcceptance({ wsRoot, run })'));
  assert.ok(read('frontend/src/api.ts').includes('acceptance?: TeamAcceptance | null'));
  assert.ok(read('frontend/src/components/TeamRunView.tsx').includes('acceptance={data?.acceptance}'));
  const ui = read('frontend/src/components/TeamRunStatus.tsx');
  for (const text of ['本快照的当前验收', 'target_changed:', 'record_missing:', 'acceptance?.status', '脚本草稿不代表真实视频已生成']) assert.ok(ui.includes(text), text);
});
