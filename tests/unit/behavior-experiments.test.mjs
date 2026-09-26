import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRunStore } from '../../engine/run-store.mjs';
import { createRunEventLog } from '../../engine/run-event-log.mjs';
import { createTaskEvidence } from '../../engine/task-evidence.mjs';
import { initFileLock } from '../../engine/file-lock.mjs';
const mod = await import('../../engine/behavior-experiments.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e;
});

function fixture(t) {
  assert.equal(typeof mod.createBehaviorExperiments, 'function');
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-behavior-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const rootDir = path.join(wsRoot, 'ledger');
  initFileLock({ dir: path.join(wsRoot, 'locks') });
  const store = createRunStore({ rootDir });
  const log = createRunEventLog({ rootDir });
  const evidence = createTaskEvidence({ wsRoot, rootDir });
  function run(id, status = 'completed', review = true) {
    const r = store.create({ sessionId: 'session-one', clientRequestId: id,
      message: 'same authorized task', model: 'selected/not-actual', backgroundRecovery: { scope: wsRoot } });
    fs.mkdirSync(path.join(wsRoot, '生成物'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, `生成物/${id}.json`), '{}');
    store.update(r.id, { status, error: status === 'failed' ? 'output_truncated' : null });
    for (const [type, data] of [['delta', { text: 'fixture response' }], ['file', { path: `生成物/${id}.json` }],
      ['model_used', { model: 'actual/text' }], ['engine_selected', { engine: 'yuanshu' }],
      ['media_completed', { model: 'actual/image' }], ['done', { usage: { input_tokens: 13, output_tokens: 7 } }]])
      log.append({ runId: r.id, sessionId: r.sessionId, type, data });
    if (review && status === 'completed') {
      const current = evidence.get(r.id);
      evidence.review(r.id, { verdict: 'pass', digest: current.digest, revision: null, skills: [], note: 'fixture human review' });
    }
    return r.id;
  }
  const baseline = run('baseline'), candidate = run('candidate');
  const body = { experimentId: 'experiment-one', sourceKind: 'synthetic-fixture', sessionId: 'session-one',
    hypothesis: 'an alternative might help', baseline: { runId: baseline, version: 'v1' },
    variants: [{ runId: candidate, version: 'v2' }] };
  const service = mod.createBehaviorExperiments({ wsRoot, rootDir, allowSynthetic: true });
  return { wsRoot, rootDir, store, log, evidence, body, service, run };
}

test('complete fixture records observed facts without claiming improvement or adoption', async t => {
  const f = fixture(t), r = await f.service.record(f.body);
  assert.equal(r.state, 'comparable');
  assert.equal(r.adoptionEligible, false); assert.equal(r.improvementProven, false);
  assert.equal(r.baseline.facts.textModel.id, 'text');
  assert.equal(r.baseline.facts.engine, 'yuanshu');
  assert.equal(r.baseline.facts.mediaModels[0].id, 'image');
  assert.equal(r.baseline.usage.observations[0].input_tokens, 13);
  assert.equal(r.baseline.usage.cost, null);
  assert.equal(r.baseline.usage.complete, false);
  assert.equal(f.service.list().counts['real-task'], 0);
  assert.equal(f.service.list().counts['synthetic-fixture'], 1);
  assert.deepEqual(await f.service.record(f.body), r);
  await assert.rejects(f.service.record({ ...f.body, hypothesis: 'changed' }), { statusCode: 409 });
});

test('missing comparison, validation and actual model remain incomplete or unknown', async t => {
  const f = fixture(t);
  f.body.variants = [];
  const r = await f.service.record(f.body); assert.equal(r.state, 'incomplete');
  const unknown = f.run('unknown', 'completed', false);
  fs.writeFileSync(path.join(f.rootDir, `events/${unknown}.jsonl`), '');
  const q = await f.service.record({ ...f.body, experimentId: 'unknown', baseline: { runId: unknown, version: 'v1' } });
  assert.equal(q.baseline.facts.textModel, null); assert.equal(q.baseline.usage.cost, null);
  assert.equal(q.state, 'incomplete'); assert.equal(q.baseline.validation.acceptance, 'pending');
});

test('failed and truncated attempts survive recording and revocation retains all evidence', async t => {
  const f = fixture(t); f.body.variants[0].runId = f.run('failure', 'failed', false);
  const r = await f.service.record(f.body); assert.equal(r.state, 'failed');
  assert.match(r.variants[0].failure, /truncated/);
  const revoked = await f.service.revoke(r.id, { revision: r.revision, reason: 'discard approach' });
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.history[0].revision, r.revision);
  assert.deepEqual(revoked.variants, r.variants);
  await assert.rejects(f.service.revoke(r.id, { revision: r.revision, reason: 'again' }), { statusCode: 409 });
  assert.equal((await f.service.record(f.body)).state, 'revoked');
});

test('artifact and run mutations invalidate a saved comparison', async t => {
  const f = fixture(t), r = await f.service.record(f.body);
  fs.writeFileSync(path.join(f.wsRoot, '生成物/candidate.json'), '{"changed":true}');
  assert.equal(f.service.get(r.id).state, 'stale');
  assert.equal(f.service.get(r.id).variants[0].artifacts[0].digest, r.variants[0].artifacts[0].digest);
});

test('scope, session, traversal, synthetic permission and oversized inputs are denied', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.record({ ...f.body, sessionId: 'another' }), { statusCode: 403 });
  await assert.rejects(f.service.record({ ...f.body, experimentId: '../escape' }), { statusCode: 400 });
  await assert.rejects(f.service.record({ ...f.body, hypothesis: 'x'.repeat(270000) }), { statusCode: 413 });
  const production = mod.createBehaviorExperiments({ wsRoot: f.wsRoot, rootDir: f.rootDir });
  await assert.rejects(production.record(f.body), { statusCode: 400 });
  f.store.update(f.body.baseline.runId, { backgroundRecovery: { scope: path.join(f.wsRoot, 'other') } });
  await assert.rejects(f.service.record(f.body), { statusCode: 403 });
});

test('parallel writes retain every experiment; corrupt storage cannot be overwritten', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.service.record({ ...f.body, experimentId: `e${i}` })));
  assert.equal(f.service.list().items.length, 8);
  const file = path.join(f.wsRoot, '记忆/运行时/行为实验', `${results[0].id}.json`);
  fs.writeFileSync(file, '{bad json');
  await assert.rejects(f.service.record({ ...f.body, experimentId: 'e0' }), { statusCode: 409 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad json');
});

test('changed run facts, input and human review invalidate earlier comparison', async t => {
  const f = fixture(t), r = await f.service.record(f.body);
  f.store.update(f.body.baseline.runId, { observability: { engine: 'pi' } });
  assert.equal(f.service.get(r.id).state, 'stale');
  const other = f.run('different');
  f.store.update(other, { request: { message: 'different task' } });
  const q = await f.service.record({ ...f.body, experimentId: 'different', variants: [{ runId: other, version: 'v3' }] });
  assert.equal(q.state, 'incomplete');
  const b = fixture(t), valid = await b.service.record(b.body), review = b.evidence.get(b.body.baseline.runId);
  b.evidence.review(review.runId, { verdict: 'revoke', digest: review.digest, revision: review.review.revision, skills: [], note: 'withdraw' });
  assert.equal(b.service.get(valid.id).state, 'stale');
});

test('linked storage and hardlinked run files are rejected without changing their targets', async t => {
  const f = fixture(t), external = path.join(f.wsRoot, 'external');
  fs.mkdirSync(external);
  fs.mkdirSync(path.join(f.wsRoot, '记忆/运行时'), { recursive: true });
  const junction = path.join(f.wsRoot, '记忆/运行时/行为实验');
  fs.symlinkSync(external, junction, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(f.service.record(f.body)); }
  finally { fs.unlinkSync(junction); }
  assert.deepEqual(fs.readdirSync(external), []);
  const g = fixture(t), original = path.join(g.rootDir, `runs/${g.body.baseline.runId}.json`);
  fs.linkSync(original, path.join(g.wsRoot, 'linked-run.json'));
  await assert.rejects(g.service.record(g.body));
});

test('atomic rename failure preserves earlier record and cleans temporary write', async t => {
  const f = fixture(t), r = await f.service.record(f.body);
  const file = path.join(f.wsRoot, '记忆/运行时/行为实验', `${r.id}.json`), original = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw Error('injected rename failure'); return rename(from, to); };
  try { await assert.rejects(f.service.revoke(r.id, { revision: r.revision, reason: 'attempt' }), /injected rename failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.readdirSync(path.dirname(file)).some(n => n.endsWith('.tmp')), false);
  assert.equal(f.service.get(r.id).state, 'comparable');
});

test('separate processes serialize duplicate recording and revocation without lost history', async t => {
  const f = fixture(t);
  const moduleUrl = new URL('../../engine/behavior-experiments.mjs', import.meta.url).href;
  const lockUrl = new URL('../../engine/file-lock.mjs', import.meta.url).href;
  const child = body => new Promise((resolve, reject) => {
    const code = `import {createBehaviorExperiments} from ${JSON.stringify(moduleUrl)};
      import {initFileLock} from ${JSON.stringify(lockUrl)};
      initFileLock({dir:${JSON.stringify(path.join(f.wsRoot, 'locks'))}});
      const s=createBehaviorExperiments(${JSON.stringify({ wsRoot: f.wsRoot, rootDir: f.rootDir, allowSynthetic: true })});
      ${body}`;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; proc.stdout.on('data', d => output += d); proc.stderr.on('data', d => output += d);
    proc.on('error', reject); proc.on('close', code => code ? reject(Error(output)) : resolve(output.trim()));
  });
  const written = await Promise.all(Array.from({ length: 4 }, () => child(`console.log((await s.record(${JSON.stringify(f.body)})).revision);`)));
  assert.equal(new Set(written).size, 1); assert.equal(f.service.list().items.length, 1);
  const r = await f.service.record(f.body);
  const results = await Promise.all(Array.from({ length: 3 }, () => child(`try { await s.revoke(${JSON.stringify(r.id)},${JSON.stringify({ revision: r.revision, reason: 'parallel' })}); console.log('ok'); } catch(e) { console.log(e.statusCode); }`)));
  assert.equal(results.filter(r => r === 'ok').length, 1);
  assert.equal(results.filter(r => r === '409').length, 2);
  assert.equal(f.service.get(r.id).history.length, 1);
});

test('completed run with truncation finishReason is not a successful comparison', async t => {
  const f = fixture(t);
  f.log.append({ runId: f.body.variants[0].runId, sessionId: 'session-one', type: 'done', data: { finishReason: 'length' } });
  const r = await f.service.record(f.body);
  assert.equal(r.state, 'failed'); assert.match(r.variants[0].failure, /length/);
});

test('existing usage events with direct token fields are retained without double-counting', async t => {
  const f = fixture(t);
  f.log.append({ runId: f.body.baseline.runId, sessionId: 'session-one', type: 'usage', data: { inputTokens: 21, outputTokens: 9, cost: 0.012 } });
  const r = await f.service.record(f.body);
  assert.equal(r.baseline.usage.observations.at(-1).inputTokens, 21);
  assert.equal(r.baseline.usage.observations.at(-1).cost, 0.012);
  assert.equal(r.baseline.usage.complete, false); assert.equal(r.baseline.usage.cost, null);
});

test('another workspace cannot read, revoke or overwrite a copied experiment', async t => {
  const f = fixture(t), r = await f.service.record(f.body), g = fixture(t);
  const folder = path.join(g.wsRoot, '记忆/运行时/行为实验'); fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, `${r.id}.json`); fs.writeFileSync(target, JSON.stringify(r));
  assert.throws(() => g.service.get(r.id), { statusCode: 409 });
  await assert.rejects(g.service.revoke(r.id, { revision: r.revision, reason: 'foreign' }), { statusCode: 409 });
  assert.equal(JSON.parse(fs.readFileSync(target)).workspace, r.workspace);
});

test('no independent review remains incomplete even with structurally valid output', async t => {
  const f = fixture(t); f.body.variants[0].runId = f.run('unreviewed', 'completed', false);
  assert.equal((await f.service.record(f.body)).state, 'incomplete');
});

test('parseable record tampering fails closed instead of claiming comparable', async t => {
  const f = fixture(t), r = await f.service.record(f.body);
  const file = path.join(f.wsRoot, '记忆/运行时/行为实验', `${r.id}.json`);
  const changed = JSON.parse(fs.readFileSync(file)); changed.baseline.version = 'forged-version';
  fs.writeFileSync(file, JSON.stringify(changed));
  assert.throws(() => f.service.get(r.id), { statusCode: 409 });
  await assert.rejects(f.service.record(f.body), { statusCode: 409 });
  assert.equal(f.service.list().counts.invalid, 1);
});
