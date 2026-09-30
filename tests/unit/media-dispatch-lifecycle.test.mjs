import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { initMediaApi, generateImage, handleImage, generateVideo, startVideoJob } from '../../engine/media-api.mjs';

async function fixture(t, respond) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
    respond(req, res, requests);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  initMediaApi({ resolveAuth: () => ({ key: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }), readJsonFile: () => ({}), getModelList: () => [] });
  return requests;
}
const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function workshop(body) {
  let status, payload;
  await handleImage({ writeHead(s) { status = s; }, end(b) { payload = JSON.parse(b); } }, body);
  return { status, ...payload };
}

test('chat and workshop both use the configured minimax adapter', async t => {
  const requests = await fixture(t, (req, res) => reply(res, 200, req.url.endsWith('image_generation') ? { data: { image_urls: ['https://fixture/image.png'] } } : { error: 'wrong adapter' }));
  assert.equal(await generateImage('minimax', 'image-01', 'cat', '1472x832'), 'https://fixture/image.png');
  assert.equal((await workshop({ provider: 'minimax', modelId: 'image-01', prompt: 'cat', size: '1472x832' })).image, 'https://fixture/image.png');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.path === '/v1/image_generation' && r.body.aspect_ratio === '16:9'));
});

test('chat preserves the workshop seedream size adaptation and generation parameters', async t => {
  const requests = await fixture(t, (_req, res) => reply(res, 200, { data: [{ url: 'https://fixture/image.png' }] }));
  await generateImage('volces-ark', 'seedream-5.0', 'cat', '832x1472', undefined, { seed: 42, negative: 'blur' });
  assert.equal(requests[0].body.size, '1440x2560');
  assert.equal(requests[0].body.seed, 42);
  assert.equal(requests[0].body.negative_prompt, 'blur');
});

for (const provider of ['generic', 'minimax']) test(`${provider} workshop never retries an uncertain paid request`, async t => {
  const requests = await fixture(t, (_req, res) => reply(res, 503, { error: 'service unavailable' }));
  const r = await workshop({ provider, modelId: 'image-01', prompt: 'cat' });
  assert.notEqual(r.status, 200);
  assert.match(r.error, /503/);
  assert.equal(requests.length, 1);
});

test('image request cancellation reaches the HTTP connection', async t => {
  const controller = new AbortController();
  await fixture(t, (_req, res) => {
    controller.abort(new Error('cancelled'));
    const timer = setTimeout(() => reply(res, 200, { data: [{ url: 'https://fixture/late.png' }] }), 700);
    res.on('close', () => clearTimeout(timer));
  });
  const started = Date.now();
  await assert.rejects(() => generateImage('generic', 'image-01', 'cat', undefined, undefined, { signal: controller.signal }));
  assert.ok(Date.now() - started < 500, 'must not wait for the late result');
});

test('cancelled video does not create a paid task', async t => {
  const requests = await fixture(t, (_req, res) => reply(res, 200, { url: 'https://fixture/video.mp4' }));
  const controller = new AbortController(); controller.abort();
  const r = await generateVideo('generic', 'video-2.5', 'cat', { signal: controller.signal }).catch(error => ({ error: error.message }));
  assert.ok(r.error);
  assert.equal(requests.length, 0);
});

test('video cancellation ends polling and retains its paid task id', async t => {
  const controller = new AbortController();
  const requests = await fixture(t, (_req, res) => {
    reply(res, 200, { task_id: 'paid-task' });
    setTimeout(() => controller.abort(), 20).unref();
  });
  const started = Date.now();
  const r = await generateVideo('generic', 'video-2.5', 'cat', { signal: controller.signal });
  assert.equal(r.task_id, 'paid-task');
  assert.equal(r.cancelled, true);
  assert.ok(Date.now() - started < 500);
  assert.equal(requests.length, 1);
});

test('video request repair is limited to explicit parameter rejections', async t => {
  const requests = await fixture(t, (_req, res) => reply(res, 503, { error: 'size service unavailable' }));
  assert.ok((await startVideoJob('generic', 'video-2.5', 'cat')).error);
  assert.equal(requests.length, 1);
});
