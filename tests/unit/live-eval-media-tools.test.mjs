import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const module = await import('../../scripts/live-eval-media-tools.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
function fixture(t, overrides = {}) {
  assert.equal(typeof module.createLiveMediaTools, 'function', 'bounded media acceptance helper must exist');
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-media-guard-test-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const imagePath = path.join(wsRoot, 'image.png');
  const marker = 'isolated-test-marker';
  const guard = module.createLiveMediaTools({ wsRoot, marker,
    generate: async () => { fs.writeFileSync(imagePath, 'fixture image bytes'); return { artifactPath: imagePath }; },
    readDimensions: () => ({ width: 1024, height: 1536 }),
    executeFile: async (name, args) => {
      const file = path.join(wsRoot, 'delivery.md');
      if (name === 'write') { fs.writeFileSync(file, args.content); return { text: 'Written' }; }
      return { text: fs.readFileSync(file, 'utf8') };
    }, ...overrides });
  return { guard, wsRoot, imagePath, marker };
}
async function makeImage(guard) {
  return guard.execute('generate_image', { prompt: 'A portrait poster', size: '1024x1536', aspect_ratio: '2:3' });
}
function delivery(f) {
  const image = f.guard.report().image;
  return [f.marker, image.path, `${image.width}x${image.height}`, image.sha256, ''].join(String.fromCharCode(10));
}
test('rejects tools, early writes and absolute-path reads outside isolated delivery', async t => {
  const { guard } = fixture(t);
  await assert.rejects(guard.execute('bash', { command: 'anything' }), /not allowed/);
  await assert.rejects(guard.execute('read', { path: 'C:/Windows/win.ini' }), /delivery.md/);
  await assert.rejects(guard.execute('write', { path: 'delivery.md', content: 'premature' }), /image first/);
  assert.equal(guard.report().passed, false);
});
test('allows only one image attempt, including when provider fails', async t => {
  const { guard } = fixture(t, { generate: async () => { throw new Error('upstream uncertain'); } });
  await assert.rejects(makeImage(guard), /upstream uncertain/);
  await assert.rejects(makeImage(guard), /one image attempt/);
  assert.equal(guard.report().generationAttempts, 1);
});
test('requires explicit portrait parameters before using paid generation', async t => {
  const { guard } = fixture(t);
  await assert.rejects(guard.execute('generate_image', { prompt: 'poster', size: '1024x1024' }), /1024x1536/);
  assert.equal(guard.report().generationAttempts, 0);
});
test('verifies real bytes, dimensions, file write and complete readback in order', async t => {
  const f = fixture(t);
  await makeImage(f.guard);
  await f.guard.execute('write', { path: 'delivery.md', content: delivery(f) });
  assert.equal(f.guard.report().passed, false, 'write alone is not verification');
  await f.guard.execute('read', { path: 'delivery.md' });
  const report = f.guard.report();
  assert.equal(report.passed, true);
  assert.equal(report.continuationPassed, true);
  assert.equal(report.dimensionsPassed, true);
  assert.deepEqual(report.events.map(e => e.name), ['generate_image', 'write', 'read']);
  assert.equal(report.delivery.sha256, report.delivery.readbackSha256);
  assert.equal(report.image.ratioExact, true);
});
test('does not accept square output or claim the prompt controlled dimensions', async t => {
  const f = fixture(t, { readDimensions: () => ({ width: 1024, height: 1024 }) });
  await makeImage(f.guard);
  await f.guard.execute('write', { path: 'delivery.md', content: delivery(f) });
  await f.guard.execute('read', { path: 'delivery.md' });
  assert.equal(f.guard.report().passed, false);
  assert.equal(f.guard.report().image.ratioExact, false);
});
test('rejects fabricated readback and incomplete evidence', async t => {
  const f = fixture(t, { executeFile: async (name, args) => {
    if (name === 'write') fs.writeFileSync(path.join(f.wsRoot, 'delivery.md'), args.content);
    return { text: name === 'read' ? 'verified successfully' : 'written' };
  } });
  await makeImage(f.guard);
  await f.guard.execute('write', { path: 'delivery.md', content: delivery(f) });
  await assert.rejects(f.guard.execute('read', { path: 'delivery.md' }), /readback/);
  assert.equal(f.guard.report().passed, false);
});
test('invalidates verification when image bytes change', async t => {
  const f = fixture(t);
  await makeImage(f.guard);
  await f.guard.execute('write', { path: 'delivery.md', content: delivery(f) });
  await f.guard.execute('read', { path: 'delivery.md' });
  fs.appendFileSync(f.imagePath, 'tampered');
  assert.equal(f.guard.report().passed, false);
  assert.equal(f.guard.report().continuationPassed, false);
});

test('separates completed continuation from correct ratio at insufficient resolution', async t => {
  const f = fixture(t, { readDimensions: () => ({ width: 832, height: 1248 }) });
  await makeImage(f.guard);
  await f.guard.execute('write', { path: 'delivery.md', content: delivery(f) });
  await f.guard.execute('read', { path: 'delivery.md' });
  const report = f.guard.report();
  assert.equal(report.continuationPassed, true);
  assert.equal(report.dimensionsPassed, false);
  assert.equal(report.image.ratioExact, true);
  assert.equal(report.image.exactSize, false);
  assert.equal(report.passed, false, 'successful tool continuation must not conceal a size downgrade');
});

test('missing evidence fails continuation even with correct dimensions and real readback', async t => {
  const f = fixture(t);
  await makeImage(f.guard);
  await f.guard.execute('write', { path: 'delivery.md', content: 'Done, but no evidence' });
  await f.guard.execute('read', { path: 'delivery.md' });
  assert.equal(f.guard.report().dimensionsPassed, true);
  assert.equal(f.guard.report().continuationPassed, false);
  assert.equal(f.guard.report().passed, false);
});

test('invalidates continuation when the verified delivery is edited later', async t => {
  const f = fixture(t);
  await makeImage(f.guard);
  await f.guard.execute('write', { path: 'delivery.md', content: delivery(f) });
  await f.guard.execute('read', { path: 'delivery.md' });
  fs.appendFileSync(path.join(f.wsRoot, 'delivery.md'), 'changed after verification');
  assert.equal(f.guard.report().continuationPassed, false);
  assert.equal(f.guard.report().passed, false);
});
