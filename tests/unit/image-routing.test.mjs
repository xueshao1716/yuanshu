import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { initMediaApi, generateMediaAsync, assistantContentWithMedia, mediaReadyNotice } from '../../engine/media-api.mjs';
import { imageCandidates, runImageCandidates } from '../../engine/image-routing.mjs';
import { sdkSafeAssistantBlocks } from '../../engine/yuanshu-session.mjs';
import { createMediaToolExecutor, MEDIA_TOOL_SCHEMAS } from '../../engine/media-channels.mjs';

const models = [
  { provider: 'agnes', id: 'agnes-image-2.5-flash', capabilities: { image: true } },
  { provider: 'relay', id: 'gpt-image-1', capabilities: { image: true } },
];
async function fixture(t, status = 200) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const body = JSON.parse(raw); calls.push(body.model);
    const code = body.model.startsWith('agnes') ? status : 200;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(code === 200 ? { data: [{ b64_json: 'aGVsbG8=' }] } : { error: 'fixture failure' }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  initMediaApi({ getModelList: () => models, readJsonFile: () => ({}),
    resolveAuth: () => ({ key: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }) });
  return calls;
}
test('explicit image model reaches the selected provider, never default Agnes', async t => {
  const calls = await fixture(t);
  const r = await generateMediaAsync({ type: 'image', provider: 'relay', modelId: 'gpt-image-1' }, 'a leaf');
  assert.deepEqual(calls, ['gpt-image-1']);
  assert.equal(r.model, 'relay/gpt-image-1');
});
test('OpenAI request selects configured GPT Image on a third-party provider', async t => {
  const calls = await fixture(t);
  await generateMediaAsync({ type: 'image' }, '用 OpenAI 画一张树叶');
  assert.deepEqual(calls, ['gpt-image-1']);
});
test('original user model instruction survives portrait prompt extraction', async t => {
  const calls = await fixture(t);
  await generateMediaAsync({ type: 'image' }, 'a portrait', { requestText: '用 OpenAI 画个你' });
  assert.deepEqual(calls, ['gpt-image-1']);
});
test('ambiguous timeout never buys a second image', async () => {
  let calls = 0;
  const r = await runImageCandidates(models, async () => { calls++; throw new Error('timeout'); });
  assert.equal(calls, 1); assert.match(r.error, /timeout/);
});
test('media history retains the actual model and fallback facts', () => {
  const attempts = [{ model: 'relay/gpt-image-1', outcome: 'succeeded' }];
  const blocks = assistantContentWithMedia('', [{ type: 'image', url: '/fixture.png', model: 'relay/gpt-image-1', attempts }]);
  assert.equal(blocks[0].model, 'relay/gpt-image-1');
  assert.deepEqual(blocks[0].attempts, attempts);
  const stored = sdkSafeAssistantBlocks(blocks).map(b => b.text || '').join('\n');
  assert.match(stored, /relay\/gpt-image-1/);
});

test('host completion tells the conversational model which image provider actually ran', () => {
  const notice = mediaReadyNotice([{ type: 'image', url: '/fixture.png', model: 'relay/gpt-image-1', attempts: [
    { model: 'agnes/agnes-image-2.5-flash', status: 429, outcome: 'failed' },
    { model: 'relay/gpt-image-1', outcome: 'succeeded' },
  ] }]);
  assert.match(notice, /relay\/gpt-image-1/);
  assert.match(notice, /429/);
});

test('automatic selection is bounded and skips disabled or edit-only backups', () => {
  const candidates = imageCandidates([...models.slice(0, 1),
    { provider: 'off', id: 'image-pro', enabled: false, capabilities: { image: true } },
    { provider: 'edit', id: 'step-image-edit-2', capabilities: { image: true } },
    models[1], { ...models[1], provider: 'other' }]);
  assert.deepEqual(candidates, models);
});

test('failed fallback is visible to the agent, including both attempts', async () => {
  const exec = createMediaToolExecutor({ generateMediaAsync: async () => ({
    error: 'upstream failed', model: 'relay/gpt-image-1', attempts: [
      { model: 'agnes/agnes-image-2.5-flash', outcome: 'failed', status: 429 },
      { model: 'relay/gpt-image-1', outcome: 'failed', status: 502 },
    ],
  }) });
  const result = await exec('generate_image', { prompt: 'leaf' });
  assert.match(result.text, /agnes\/agnes-image-2.5-flash.*429/);
  assert.match(result.text, /relay\/gpt-image-1.*502/);
});
test('automatic selection changes provider on 429 and reports actual attempts', async t => {
  const calls = await fixture(t, 429);
  const r = await generateMediaAsync({ type: 'image' }, 'a leaf');
  assert.deepEqual(calls, ['agnes-image-2.5-flash', 'gpt-image-1']);
  assert.equal(r.model, 'relay/gpt-image-1');
  assert.equal(r.attempts[0].status, 429);
  assert.equal(r.attempts[1].outcome, 'succeeded');
});
test('explicit model failure never silently changes model', async t => {
  const calls = await fixture(t, 429);
  const r = await generateMediaAsync({ type: 'image', provider: 'agnes', modelId: models[0].id }, 'a leaf');
  assert.deepEqual(calls, [models[0].id]);
  assert.ok(r.error);
});
test('invalid explicit selection fails before any billable request', async t => {
  const calls = await fixture(t);
  const r = await generateMediaAsync({ type: 'image', provider: 'missing' }, 'a leaf');
  assert.deepEqual(calls, []);
  assert.match(r.error, /未配置|不存在/);
});
test('content/request rejection does not trigger another provider', async t => {
  const calls = await fixture(t, 400);
  const r = await generateMediaAsync({ type: 'image' }, 'a leaf');
  assert.deepEqual(calls, [models[0].id]);
  assert.ok(r.error);
});
test('tool schema and executor preserve model selection and route facts', async () => {
  const schema = MEDIA_TOOL_SCHEMAS.find(s => s.function.name === 'generate_image').function.parameters.properties;
  assert.ok(schema.provider && schema.modelId);
  let captured;
  const exec = createMediaToolExecutor({ generateMediaAsync: async intent => {
    captured = intent;
    return { type: 'image', url: '/fixture.png', model: 'relay/gpt-image-1', attempts: [{ model: 'relay/gpt-image-1', outcome: 'succeeded' }] };
  } });
  const r = await exec('generate_image', { prompt: 'leaf', provider: 'relay', modelId: 'gpt-image-1' });
  assert.equal(captured.provider, 'relay');
  assert.equal(captured.modelId, 'gpt-image-1');
  assert.equal(r.media.model, 'relay/gpt-image-1');
  assert.equal(r.media.attempts.length, 1);
});
