import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { json, readBody } from '../../engine/http-utils.mjs';
import { createPendingApi } from '../../engine/pending-api.mjs';
import { createHistoryApi } from '../../engine/history-api.mjs';
import { stageTeamDraft } from '../../scripts/team-draft-delivery.mjs';

const module = await import('../../engine/team-run-read.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});

// Real production handlers over loopback HTTP; not the full authenticated server.
async function fixture(t, { existing = false, stage = true } = {}) {
  assert.equal(typeof module.createTeamRunRead, 'function', 'bounded team snapshot handler must exist');
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-http-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const snapshot = path.join(wsRoot, '工程/多AI角色扮演系统/team-run.json');
  const launch = { id: 'fixture-launch', status: 'completed' };
  const getRun = module.createTeamRunRead({ wsRoot, json, getLaunch: () => launch });
  const pending = createPendingApi({ wsRoot, json, readBody });
  const history = createHistoryApi({ wsRoot, json, readBody });
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/team/run') return getRun(res);
      if (req.method === 'POST' && req.url === '/api/pending') return await pending.create(res, await readBody(req));
      const match = /^\/api\/pending\/(p[a-z0-9-]+)\/(accept|reject)$/.exec(req.url);
      if (req.method === 'POST' && match) return await pending[match[2]](res, match[1], await readBody(req));
      if (req.method === 'POST' && req.url === '/api/history/rollback') return await history.rollback(res, await readBody(req));
      return json(res, 404, { error: 'not found' });
    } catch { return json(res, 500, { error: 'fixture request failed' }); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = async (url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const runId = 'http-fixture';
  const target = path.join(wsRoot, `工程/多AI角色扮演系统/runs/${runId}/交付/终稿.md`);
  if (existing) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '旧版本'); }
  let run;
  if (stage) {
    const delivery = await stageTeamDraft({ wsRoot, runId, content: '# 新草稿\n人工验收', eligible: true,
      submit: async body => (await request('/api/pending', body)).body });
    assert.equal(delivery.status, 'awaiting_acceptance');
    run = { runId, launchId: launch.id, delivery };
    fs.writeFileSync(snapshot, JSON.stringify(run));
  }
  return { wsRoot, snapshot, launch, run, target, request,
    get: () => request('/api/team/run'),
    decide: action => request(`/api/pending/${run.delivery.proposalId}/${action}`, {}),
  };
}

test('HTTP submit → pending → accept, preserving the historical snapshot', async t => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.snapshot, 'utf8');
  assert.equal(fs.existsSync(f.target), false);
  assert.equal((await f.get()).body.acceptance.status, 'pending');
  assert.equal((await f.decide('accept')).status, 200);
  const result = await f.get();
  assert.equal(result.status, 200);
  assert.equal(result.body.acceptance.status, 'accepted');
  assert.equal(result.body.run.delivery.status, 'awaiting_acceptance');
  assert.deepEqual(result.body.launch, f.launch);
  assert.equal(fs.readFileSync(f.snapshot, 'utf8'), before);
  assert.equal((await f.decide('accept')).status, 409);
});

test('HTTP reject remains rejected without publishing a target', async t => {
  const f = await fixture(t);
  assert.equal((await f.decide('reject')).status, 200);
  assert.equal((await f.get()).body.acceptance.status, 'rejected');
  assert.equal(fs.existsSync(f.target), false);
});

test('HTTP history rollback revokes current file-consistency confirmation', async t => {
  const f = await fixture(t, { existing: true });
  const accepted = await f.decide('accept');
  assert.equal(accepted.status, 200);
  assert.equal((await f.get()).body.acceptance.status, 'accepted');
  assert.equal((await f.request('/api/history/rollback', { backup: accepted.body.backup })).status, 200);
  assert.equal((await f.get()).body.acceptance.status, 'target_changed');
  assert.equal(fs.readFileSync(f.target, 'utf8'), '旧版本');
});

test('HTTP baseline conflict cannot become accepted or overwrite later edits', async t => {
  const f = await fixture(t, { existing: true });
  fs.writeFileSync(f.target, '人工新改动');
  assert.equal((await f.decide('accept')).status, 409);
  assert.equal((await f.get()).body.acceptance.status, 'pending');
  assert.equal(fs.readFileSync(f.target, 'utf8'), '人工新改动');
});

test('HTTP corrupted proposal cannot retain a previously accepted status', async t => {
  const f = await fixture(t);
  await f.decide('accept');
  assert.equal((await f.get()).body.acceptance.status, 'accepted');
  fs.writeFileSync(path.join(f.wsRoot, `工程/待审/${f.run.delivery.proposalId}.json`), '{broken');
  assert.equal((await f.get()).body.acceptance.status, 'unknown');
});

test('HTTP missing snapshot still exposes launch state', async t => {
  const f = await fixture(t, { stage: false });
  const result = await f.get();
  assert.equal(result.status, 200);
  assert.equal(result.body.run, null);
  assert.deepEqual(result.body.launch, f.launch);
});

for (const value of ['{private-content', 'null', '[]', '42', '"string"']) {
  test(`HTTP invalid snapshot fails closed: ${value}`, async t => {
    const f = await fixture(t);
    fs.writeFileSync(f.snapshot, value);
    const result = await f.get();
    assert.equal(result.status, 500);
    assert.equal(result.body.run, undefined);
    assert.equal(result.body.acceptance, undefined);
    assert.ok(!result.body.error.includes('private-content'));
    assert.ok(!result.body.error.includes(f.wsRoot));
  });
}

test('HTTP oversized snapshot is rejected without unbounded readFileSync', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.snapshot, '{"padding":"' + 'x'.repeat(16_000_001) + '"}');
  const original = fs.readFileSync;
  let unboundedReads = 0;
  fs.readFileSync = function(file, ...args) {
    if (String(file) === f.snapshot) unboundedReads++;
    return original.call(this, file, ...args);
  };
  try { assert.equal((await f.get()).status, 500); }
  finally { fs.readFileSync = original; }
  assert.equal(unboundedReads, 0, 'snapshot read must be bounded at the descriptor');
});

test('HTTP hardlinked snapshot is rejected', async t => {
  const f = await fixture(t);
  fs.linkSync(f.snapshot, path.join(f.wsRoot, 'linked-snapshot'));
  assert.equal((await f.get()).status, 500);
});

test('production team GET delegates to the handler tested over HTTP', () => {
  const source = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('createTeamRunRead({ wsRoot: CONFIG.cwd, json, getLaunch: () => teamLauncher.status() })'));
  assert.ok(source.includes('["GET", "/api/team/run", (res) => teamRunRead(res)]'));
});
