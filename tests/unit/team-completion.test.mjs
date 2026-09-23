import test from 'node:test';
import assert from 'node:assert/strict';
import { initSubagent, getSubagentHistory } from '../../engine/subagent.mjs';

test('video completion binds shared children to active launcher, rejecting forged/unbound calls', async () => {
  const mod = await import('../../engine/team-completion.mjs').catch(() => ({}));
  assert.equal(typeof mod.createTeamCompletion, 'function');
  const events = [], requests = [];
  initSubagent({ getDefaultModel: () => ({ provider: 'fake', id: 'test' }),
    modelReader: () => ({ fake: { models: [{ id: 'test', maxTokens: 32768, baseUrl: 'https://fake.invalid' }] } }),
    resolveAuth: () => ({ baseUrl: 'https://fake.invalid' }), authReader: () => ({ fake: { key: 'test' } }),
    httpFetch: async (_u, opts) => { requests.push(JSON.parse(opts.body)); return { ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"final":{"title":"实际稿"}}' } }] }) }; },
  });
  const complete = mod.createTeamCompletion({ launcher: { childContext: id => id === 'active'
    ? { runId: 'parent', sessionId: 'session', onEvent: (type, data) => events.push({ type, data }) } : null } });
  await assert.rejects(complete({ launchId: 'forged', runId: 'parent', provider: 'fake', modelId: 'test', message: 'draft' }), /绑定/);
  assert.equal(requests.length, 0);
  const r = await complete({ launchId: 'active', role: 'VIDEO', provider: 'fake', modelId: 'test', message: 'draft' });
  assert.match(r.text, /实际稿/);
  assert.equal(requests.length, 1); assert.equal(requests[0].max_tokens, 7000);
  assert.equal(events.length, 2);
  assert.ok(events.every(e => e.data.parentRunId === 'parent' && e.data.sessionId === 'session' && e.data.id === r.subagentRunId));
  assert.equal((await getSubagentHistory({ runId: 'parent' }))[0].status, 'completed');
});
