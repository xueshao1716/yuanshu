import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageTeamDraft, hasNoUnresolved } from '../../scripts/team-draft-delivery.mjs';

test('unresolved gate requires an explicit empty array', () => {
  for (const value of [undefined, null, {}, { unresolved: null }, { unresolved: '' }, { unresolved: 'none' }, { unresolved: [{}] }]) {
    assert.equal(hasNoUnresolved(value), false);
  }
  assert.equal(hasNoUnresolved({ unresolved: [] }), true);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-draft-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('draft is staged privately and only acceptance writes the final target', async t => {
  const wsRoot = fixture(t);
  const { createPendingApi } = await import('../../engine/pending-api.mjs');
  const api = createPendingApi({ wsRoot, json: (_, status, body) => ({ status, ...body }) });
  const result = await stageTeamDraft({ wsRoot, runId: 'run-1', content: '# ../../unsafe title', eligible: true,
    submit: body => api.create(null, body) });
  assert.equal(result.status, 'awaiting_acceptance');
  assert.ok(result.proposalId);
  assert.equal(fs.existsSync(path.join(wsRoot, result.target)), false);
  assert.equal(fs.readFileSync(path.join(wsRoot, result.draft), 'utf8'), '# ../../unsafe title');
  assert.equal((await api.accept(null, result.proposalId)).status, 200);
  assert.equal(fs.readFileSync(path.join(wsRoot, result.target), 'utf8'), '# ../../unsafe title');
});

test('failed quality does not submit a proposal', async t => {
  const result = await stageTeamDraft({ wsRoot: fixture(t), runId: 'run-2', content: 'draft', eligible: false,
    submit: () => assert.fail('must not submit') });
  assert.equal(result.status, 'quality_failed');
  assert.equal(result.proposalId, undefined);
});

test('failed submission preserves draft without claiming delivery', async t => {
  const wsRoot = fixture(t);
  for (const submit of [async () => ({ ok: false, error: 'denied' }), async () => { throw new Error('unavailable'); }]) {
    const result = await stageTeamDraft({ wsRoot, runId: crypto.randomUUID(), content: 'draft', eligible: true, submit });
    assert.equal(result.status, 'submission_failed');
    assert.equal(fs.existsSync(path.join(wsRoot, result.target)), false);
    assert.equal(fs.readFileSync(path.join(wsRoot, result.draft), 'utf8'), 'draft');
  }
});

test('run IDs cannot control directories', async t => {
  const wsRoot = fixture(t);
  for (const runId of ['../escape', 'a/b', 'a:b', 'CON', '']) {
    await assert.rejects(stageTeamDraft({ wsRoot, runId, content: 'draft', eligible: false }), /runId/);
  }
});

test('candidate runner has no literal bearer credential or direct final write', () => {
  const source = fs.readFileSync(new URL('../../scripts/team-run-live.mjs', import.meta.url), 'utf8');
  assert.equal(/Authorization:\s*['"]Bearer\s+[^'"]+['"]/.test(source), false, 'literal credential found');
  assert.ok(source.includes('stageTeamDraft('));
  assert.equal(source.includes("fs.writeFileSync(path.join(runDir, '交付'"), false);
  assert.equal(source.includes('不影响交付'), false);
  assert.ok(source.includes('hasNoUnresolved(finObj)'));
  assert.ok(source.includes('"unresolved":[]'), 'final JSON example must declare unresolved');
  assert.equal(source.includes('unresolved 有就另起一行'), false);
  assert.equal(source.includes('4镜×2.5s'), false);
});
