import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSubagent, getSubagentHistory } from '../../engine/subagent.mjs';
import { createPiTeamTool, withTeamToolContext } from '../../engine/team-tool-context.mjs';
import { executeTeam } from '../../engine/team-subagents.mjs';
import { runYuanshuToolRound } from '../../engine/yuanshu-loop.mjs';

test('Pi and Yuanshu tools share real children without crossing concurrent session contexts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  initSubagent({ traceDir: path.join(root, 'children'), getDefaultModel: () => null, getFlashModel: () => null,
    modelReader: () => ({ fixture: { models: ['pi-model', 'yuanshu-model'].map(id => ({ id, baseUrl: 'https://fake.invalid' })) } }),
    authReader: () => ({ fixture: { type: 'api_key', key: 'test' } }), resolveAuth: () => ({ baseUrl: 'https://fake.invalid' }),
    httpFetch: async (_url, opts) => {
      const body = JSON.parse(opts.body); requests.push(body);
      await new Promise(resolve => setImmediate(resolve));
      const review = body.messages.at(-1).content.startsWith('REVIEW');
      const result = review ? '{"pass":true,"issues":[]}' : `正文 ${body.model}`;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: review ? result : JSON.stringify({ result }) } }] }) };
    },
  });
  // TypeBox's constructor shapes only; runtime behaviour is the production adapter.
  const Type = { Object: x => x, String: () => ({}), Array: x => x, Optional: x => x };
  const tool = createPiTeamTool(Type);
  const events = { pi: [], yuanshu: [] };
  const host = engine => ({ wsRoot: root, runId: engine, sessionId: `${engine}-session`, model: { provider: 'fixture', id: `${engine}-model` },
    history: [{ role: 'user', content: `${engine}-private` }, { role: 'assistant', content: '收到' }],
    onEvent: (type, data) => events[engine].push({ type, data }) });
  const denied = await tool.execute('unbound', { task: 'test', runId: 'forged' });
  assert.equal(denied.isError, true); assert.equal(requests.length, 0);
  const [pi, yuanshu] = await Promise.all([
    withTeamToolContext(host('pi'), () => tool.execute('p', { task: 'test' })),
    runYuanshuToolRound({ toolCalls: [{ id: 'y', type: 'function', function: { name: 'delegate_team', arguments: '{"task":"test"}' } }],
      history: [], executionContext: host('yuanshu'), execute: (_name, args, ctx) => executeTeam(args, { ...ctx, wsRoot: root }),
    }),
  ]);
  assert.equal(pi.isError, false); assert.equal(yuanshu.toolPlan[0].status, 'completed');
  assert.equal(requests.length, 8);
  for (const engine of ['pi', 'yuanshu']) {
    const records = await getSubagentHistory({ runId: engine });
    assert.equal(records.length, 4);
    assert.ok(records.every(r => r.sessionId === `${engine}-session` && r.model === `fixture/${engine}-model`));
    assert.equal(events[engine].filter(e => e.type === 'subagent_finished').length, 4);
    const own = requests.filter(r => r.model === `${engine}-model`);
    assert.ok(own.every(r => JSON.stringify(r.messages).includes(`${engine}-private`)));
    const other = engine === 'pi' ? 'yuanshu' : 'pi';
    assert.ok(own.every(r => !JSON.stringify(r.messages).includes(`${other}-private`)));
  }
  const cancelled = await withTeamToolContext(host('pi'), () => tool.execute('cancel', { task: 'test' }, AbortSignal.abort()));
  assert.equal(cancelled.isError, true); assert.equal(requests.length, 8);
});
