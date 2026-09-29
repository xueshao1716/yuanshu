import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const target = new URL('../../engine/sampling-params.mjs', import.meta.url);
async function module() { assert.ok(fs.existsSync(target), 'per-request sampling adapter exists'); return import(target); }
test('Pi sends both sampling values through the existing payload hook and restores it', async () => {
  const { withSamplingParams } = await module();
  const original = async p => ({ ...p, extension: true });
  const session = { agent: { onPayload: original } };
  const output = await withSamplingParams(session, { temperature: 0, top_p: 0.8 }, async () => {
    const first = await session.agent.onPayload({ messages: [] }, { api: 'openai-completions', id: 'glm-5.3-flash' });
    const second = await session.agent.onPayload({ messages: ['tool result'] }, { api: 'openai-completions', id: 'glm-5.3-flash' });
    assert.equal(second.temperature, 0); return first;
  });
  assert.deepEqual(output, { messages: [], extension: true, temperature: 0, top_p: 0.8 });
  assert.equal(session.agent.onPayload, original);
  await assert.rejects(withSamplingParams(session, { top_p: 0.9 }, async () => { throw new Error('abort'); }), /abort/);
  assert.equal(session.agent.onPayload, original);
});
test('default and invalid values never override the model; provider constraints are respected', async () => {
  const { samplingPayload, normalizeSamplingParams, withSamplingParams } = await module();
  assert.deepEqual(normalizeSamplingParams({ temperature: NaN, top_p: 3, extra: true }), {});
  assert.deepEqual(normalizeSamplingParams({ top_p: 0.5 }), { top_p: 0.5 });
  assert.deepEqual(samplingPayload({ temperature: 1 }, {}, undefined), { temperature: 1 });
  assert.deepEqual(samplingPayload({}, { api: 'anthropic-messages' }, { temperature: 0.7, top_p: 0.95 }), { temperature: 0.7 });
  assert.deepEqual(samplingPayload({}, { api: 'anthropic-messages' }, { temperature: 1.8 }), { temperature: 1 });
  assert.deepEqual(samplingPayload({ thinking: { type: 'enabled' } }, { api: 'anthropic-messages' }, { temperature: 0.7 }), { thinking: { type: 'enabled' } });
  assert.deepEqual(samplingPayload({}, { api: 'openai-responses', id: 'o3' }, { temperature: 0.7, top_p: 0.9 }), {});
  const session = { agent: { onPayload: undefined } };
  await withSamplingParams(session, undefined, async () => assert.equal(session.agent.onPayload, undefined));
});
test('primary Pi request uses sampling adapter; UI distinguishes model defaults from overrides', () => {
  const server = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes('withSamplingParams(agent, body.params'));
  const ui = fs.readFileSync(new URL('../../frontend/src/components/ParamsPanel.tsx', import.meta.url), 'utf8');
  assert.ok(ui.includes('模型默认')); assert.ok(ui.includes('下次发送生效'));
  assert.ok(!ui.includes('会话级 · 存本地'));
});
