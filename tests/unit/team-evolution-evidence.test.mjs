import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPendingApi } from '../../engine/pending-api.mjs';
import { stageTeamDraft } from '../../scripts/team-draft-delivery.mjs';
import { grant, loadLedger } from '../../engine/autonomy.mjs';
const mod = await import('../../engine/team-evolution-evidence.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('team model review, acceptance, and cost remain separate; acceptance is refreshed after real review', async t => {
  const wsRoot = root(t);
  assert.equal(typeof mod.recordTeamEvidence, 'function');
  const api = createPendingApi({ wsRoot, json: (_, status, body) => ({ status, ...body }) });
  const runId = 'fixture-evolution';
  const delivery = await stageTeamDraft({ wsRoot, runId, content: '# 终稿\n真实的隔离样本', eligible: true,
    submit: body => api.create(null, body) });
  const run = { runId, mode: 'real', task: '写脚本', delivery, checklist: { total: 3, passed: 3, failed: 0 }, elapsedMs: 1000,
    cost: { reservedCalls: 8 }, createdAt: '2026-09-21T00:00:00Z' };
  assert.equal(mod.recordTeamEvidence(wsRoot, run).ok, true);
  assert.equal(mod.recordTeamEvidence(wsRoot, run).ok, true);
  let rows = mod.collectTeamEvidence(wsRoot);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].modelReview.verdict, 'PASS');
  assert.equal(rows[0].acceptance.status, 'pending');
  assert.equal(rows[0].accepted, false);
  assert.equal(rows[0].cost.currency, null);
  await api.accept(null, delivery.proposalId);
  rows = mod.collectTeamEvidence(wsRoot);
  assert.equal(rows[0].accepted, true);
  assert.equal(rows[0].eligibleForFixPolicy, false);
  fs.writeFileSync(path.join(wsRoot, delivery.target), 'changed');
  assert.equal(mod.collectTeamEvidence(wsRoot)[0].accepted, false);
});
test('an explicit failed apply result cannot appear in successful autonomy ledger', async t => {
  const wsRoot = root(t);
  const result = await grant({ kind: 'config', text: '调整重试次数' },
    { replayable: true, episodes: 8, noWorse: true, betterCount: 1, reversible: true, scope: 'config' },
    { wsRoot, apply: async () => ({ ok: false, error: 'disk full' }) });
  assert.equal(result.decided, false);
  assert.equal(loadLedger(wsRoot).some(r => r.auto), false);
});

test('existing latest real run can be backfilled once without inventing acceptance', t => {
  const wsRoot = root(t);
  assert.equal(typeof mod.ingestLatestTeamEvidence, 'function');
  const folder = path.join(wsRoot, '工程/多AI角色扮演系统');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'team-run.json'), JSON.stringify({
    runId: 'historical-real', mode: 'real', task: '历史任务', delivery: { status: 'quality_failed' } }));
  mod.ingestLatestTeamEvidence(wsRoot);
  mod.ingestLatestTeamEvidence(wsRoot);
  const rows = mod.collectTeamEvidence(wsRoot);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accepted, false);
  assert.equal(rows[0].cost.reservedCalls, null);
});
