import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspaceApi, saveArtifact } from '../../engine/workspace-api.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const artifact = { type: 'image', url: 'https://cdn.example.test/image.png', prompt: 'cancel fixture' };
function setup(t, fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-artifact-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initWorkspaceApi({ wsRoot: root, fetchImpl });
  return () => fs.readdirSync(root, { recursive: true }).filter(n => /\.(png|json)$/.test(n));
}

test('pre-cancelled artifact neither downloads nor writes a file', async t => {
  let calls = 0;
  const files = setup(t, async () => { calls++; return { ok: true, buffer: () => PNG }; });
  const controller = new AbortController();
  controller.abort(new Error('本轮已取消'));
  for (const url of [artifact.url, `data:image/png;base64,${PNG.toString('base64')}`]) {
    const result = await saveArtifact({ ...artifact, url, signal: controller.signal });
    assert.equal(result.local, false);
    assert.match(result.reason, /取消/);
  }
  assert.equal(calls, 0);
  assert.deepEqual(files(), []);
});

test('artifact cancellation reaches downloader and prevents retry', async t => {
  const controller = new AbortController();
  let calls = 0, receivedSignal;
  const files = setup(t, async (_url, options) => {
    calls++; receivedSignal = options.signal;
    controller.abort(new Error('下载已取消'));
    throw new Error('timeout');
  });
  const result = await saveArtifact({ ...artifact, signal: controller.signal });
  assert.equal(receivedSignal, controller.signal);
  assert.equal(calls, 1);
  assert.equal(result.local, false);
  assert.match(result.reason, /取消/);
  assert.deepEqual(files(), []);
});

test('late download response after cancellation cannot persist an artifact', async t => {
  const controller = new AbortController();
  const files = setup(t, async () => {
    controller.abort(new Error('已取消'));
    return { ok: true, buffer: () => PNG };
  });
  const result = await saveArtifact({ ...artifact, signal: controller.signal });
  assert.equal(result.local, false);
  assert.deepEqual(files(), []);
});
