import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunStore } from '../../engine/run-store.mjs';
import { createRunEventLog } from '../../engine/run-event-log.mjs';
const mod = await import('../../engine/task-evidence.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});

function fixture(t, opts = {}) {
  assert.equal(typeof mod.createTaskEvidence, 'function');
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const rootDir = path.join(wsRoot, 'runtime');
  const store = createRunStore({ rootDir, now: () => '2026-09-20T00:00:00Z' });
  const log = createRunEventLog({ rootDir });
  const run = store.create({ sessionId: 'session-one', clientRequestId: 'request-one', message: '制作一幅画', ...opts });
  const event = (type, data, extra = {}) => log.append({ runId: run.id, sessionId: run.sessionId, type, data, ...extra });
  event('tool', { id: 'skill-one', name: 'activate_skill', args: { name: 'image-generation' } });
  event('tool_end', { id: 'skill-one', name: 'activate_skill', isError: false, output: 'loaded' });
  event('delta', { text: '交付结果，请检查。' });
  store.update(run.id, { status: 'completed' });
  const service = mod.createTaskEvidence({ wsRoot, rootDir });
  const submit = (verdict = 'pass', skills = ['image-generation'], overrides = {}) => {
    const current = service.get(run.id);
    return service.review(run.id, { digest: current.digest, revision: current.review?.revision || null,
      verdict, skills, note: '已核对本次交付与任务要求', ...overrides });
  };
  return { wsRoot, rootDir, store, log, run, event, service, submit };
}

test('child facts require matching lifecycle and never become skill labels', t => {
  const f = fixture(t, { workflow: 'team-general' });
  const data = { id: 'child-one', runId: 'child-one', parentRunId: f.run.id, sessionId: f.run.sessionId,
    role: 'planner', model: { provider: 'fixture', id: 'text' } };
  f.event('subagent_started', { ...data, status: 'running' });
  f.event('subagent_finished', { ...data, status: 'completed', summary: '真实正文' });
  f.event('subagent_finished', { ...data, id: 'foreign', runId: 'foreign', parentRunId: 'another-run', status: 'completed' });
  const detail = f.service.get(f.run.id);
  assert.equal(detail.lane, 'task');
  assert.equal(detail.subagents.length, 1);
  assert.equal(detail.subagents[0].status, 'completed');
  assert.equal(detail.subagents[0].summary, '真实正文');
  assert.deepEqual(detail.skills, ['image-generation']);
  assert.ok(detail.issues.some(s => s.includes('子任务')));
});

test('acceptance is persistent and only explicitly validated actual skills become revocable evidence', t => {
  const f = fixture(t);
  assert.deepEqual(f.service.get(f.run.id).skills, ['image-generation']);
  assert.equal(f.service.episodes().length, 0);
  f.submit('pass', []);
  assert.equal(f.service.get(f.run.id).acceptance, 'pass');
  assert.equal(f.service.episodes().length, 0);
  const accepted = f.submit();
  const reopened = mod.createTaskEvidence({ wsRoot: f.wsRoot, rootDir: f.rootDir });
  const [ep] = reopened.episodes();
  assert.equal(ep.runId, f.run.id);
  assert.equal(ep.at, f.run.createdAt, 'review time must not make old tasks future observations');
  assert.equal(ep.verification.skillValidated, true);
  assert.ok(ep.verification.reference.includes(accepted.review.revision));
  assert.equal(ep.input, '制作一幅画');
  f.submit('revoke', []);
  assert.equal(reopened.episodes().length, 0);
  assert.equal(reopened.get(f.run.id).acceptance, 'revoke');
});

test('changing output invalidates an accepted review and stale browser submissions conflict', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.wsRoot, '生成物'));
  const file = path.join(f.wsRoot, '生成物', 'image.png');
  fs.writeFileSync(file, 'original-image');
  f.event('file', { path: '生成物/image.png' });
  const old = f.service.get(f.run.id);
  f.submit();
  assert.throws(() => f.submit('pass', [], { revision: null }), { statusCode: 409 });
  fs.writeFileSync(file, 'modified-image');
  assert.equal(f.service.get(f.run.id).acceptance, 'stale');
  assert.equal(f.service.episodes().length, 0);
  assert.throws(() => f.submit('pass', [], { digest: old.digest }), { statusCode: 409 });
  f.submit('fail', []);
  assert.equal(f.service.episodes().length, 0);
});

test('failed, unfinished and invented skills cannot be validated', t => {
  const f = fixture(t);
  f.event('tool', { id: 'bad', name: 'activate_skill', args: { name: 'bad-skill' } });
  f.event('tool_end', { id: 'bad', name: 'activate_skill', isError: true, output: 'failed' });
  f.event('tool', { id: 'pending', name: 'activate_skill', args: { skill: 'pending-skill' } });
  assert.deepEqual(f.service.get(f.run.id).skills, ['image-generation']);
  for (const skill of ['bad-skill', 'pending-skill', 'invented'])
    assert.throws(() => f.submit('pass', [skill]), { statusCode: 400 });
  assert.throws(() => f.submit('pass', [], { note: '' }), { statusCode: 400 });
});

test('duplicate completion and incomplete original requests cannot become evidence', t => {
  const f = fixture(t);
  f.event('tool_end', { id: 'skill-one', name: 'activate_skill', isError: true });
  assert.equal(f.service.get(f.run.id).reviewable, false);
  assert.throws(() => f.submit(), { statusCode: 400 });
  f.store.update(f.run.id, { request: null });
  assert.ok(f.service.get(f.run.id).issues.some(s => s.includes('原始任务')));
});

test('input attachments without captured original bytes require separate review', t => {
  const f = fixture(t, { files: [{ path: 'uploads/reference.png' }] });
  assert.equal(f.service.get(f.run.id).reviewable, false);
});

test('reviewed older tasks remain accessible after forty newer runs', t => {
  const f = fixture(t); f.submit();
  for (let i = 0; i < 41; i++) {
    const run = f.store.create({ sessionId: 'new', clientRequestId: `new-${i}`, message: 'new task' });
    f.store.update(run.id, { createdAt: '2026-09-21T00:00:00Z' });
  }
  assert.equal(f.service.list().items.length, 41);
  assert.ok(f.service.list().items.some(r => r.runId === f.run.id));
});

for (const status of ['running', 'failed', 'interrupted', 'stopped']) test(`${status} task cannot pass`, t => {
  const f = fixture(t);
  f.store.update(f.run.id, { status });
  assert.equal(f.service.get(f.run.id).reviewable, false);
  assert.throws(() => f.submit(), { statusCode: 400 });
});

test('Team cannot bypass its existing proposal acceptance', t => {
  const f = fixture(t, { workflow: 'team-video' });
  assert.equal(f.service.get(f.run.id).lane, 'team');
  assert.throws(() => f.submit(), { statusCode: 400 });
});

for (const target of ['../outside.txt', '.token', '生成物/missing.png', 'https://example.org/image.png'])
  test(`uninspectable artifact fails closed: ${target}`, t => {
    const f = fixture(t);
    f.event('file', { path: target });
    assert.equal(f.service.get(f.run.id).reviewable, false);
    assert.throws(() => f.submit(), { statusCode: 400 });
  });

test('remote media without a local delivery cannot pass', t => {
  const f = fixture(t);
  f.event('media', { type: 'image', url: 'https://example.org/image.png' });
  assert.equal(f.service.get(f.run.id).reviewable, false);
});

for (const mode of ['success', 'failed', 'unfinished', 'ambiguous']) test(`image download provenance: ${mode}`, t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.wsRoot, '生成物'));
  const file = path.join(f.wsRoot, '生成物', 'image.png'); fs.writeFileSync(file, 'image');
  const url = 'https://example.org/image.png';
  f.event('media', { type: 'image', url });
  f.event('tool', { id: 'download', name: 'bash', args: { command: `curl -sL -o "${file}" "${url}"${mode === 'ambiguous' ? ' && echo done' : ''}` } });
  if (mode !== 'unfinished') f.event('tool_end', { id: 'download', name: 'bash', isError: mode === 'failed', output: 'saved' });
  f.event('file', { path: '生成物/image.png' });
  const row = f.service.get(f.run.id);
  assert.equal(row.reviewable, mode === 'success');
  if (mode === 'success') {
    assert.equal(row.artifacts.length, 1);
    f.submit();
    assert.equal(f.service.list().summary.coverage.image, 1);
  }
});

test('accepted task counts and coverage are separate from skill eligibility', t => {
  const f = fixture(t);
  f.submit('pass', []);
  let stats = f.service.list().summary;
  assert.equal(stats.pass, 1);
  assert.equal(stats.eligible, 0);
  assert.equal(stats.coverage.text, 1);
  f.submit();
  assert.equal(f.service.list().summary.eligible, 1);
  f.submit('revoke', []);
  stats = f.service.list().summary;
  assert.equal(stats.pass, 0);
  assert.equal(stats.revoke, 1);
});

test('hardlinked and oversized artifacts cannot pass', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.wsRoot, '生成物'));
  const source = path.join(f.wsRoot, 'source'); fs.writeFileSync(source, 'secret');
  const dest = path.join(f.wsRoot, '生成物', 'out.txt'); fs.linkSync(source, dest);
  f.event('file', { path: '生成物/out.txt' });
  assert.equal(f.service.get(f.run.id).reviewable, false);
  fs.unlinkSync(dest); fs.writeFileSync(dest, Buffer.alloc(9 * 1024 * 1024));
  assert.equal(f.service.get(f.run.id).reviewable, false);
});

test('foreign, malformed or discontinuous events are not trustworthy output', t => {
  const f = fixture(t);
  f.event('delta', { text: 'foreign result' }, { sessionId: 'foreign-session' });
  assert.equal(f.service.get(f.run.id).reviewable, false);
  const file = path.join(f.rootDir, 'events', `${f.run.id}.jsonl`);
  fs.writeFileSync(file, '{broken');
  assert.equal(f.service.get(f.run.id).reviewable, false);
  assert.throws(() => f.service.get('../escape'), { statusCode: 400 });
});

test('same-run markdown delivery links are content-bound; rejected inputs cannot overwrite stored review', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.wsRoot, '生成物'));
  const file = path.join(f.wsRoot, '生成物', 'answer.md'); fs.writeFileSync(file, 'answer');
  f.event('delta', { text: '[文档](/api/ws/file?path=%E7%94%9F%E6%88%90%E7%89%A9%2Fanswer.md)' });
  f.submit();
  assert.equal(f.service.get(f.run.id).artifacts.length, 1);
  assert.throws(() => f.submit('bogus'), { statusCode: 400 });
  fs.unlinkSync(file);
  assert.equal(f.service.get(f.run.id).acceptance, 'stale');
});
