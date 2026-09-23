import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createGeneralTeamChat } from '../../engine/team-general-chat.mjs';
import { initSubagent } from '../../engine/subagent.mjs';
import { createRunStore } from '../../engine/run-store.mjs';
import { createRunEventLog } from '../../engine/run-event-log.mjs';
import { createRunManager } from '../../engine/run-manager.mjs';
import { createAIBodyRuntime } from '../../engine/aibody-runtime.mjs';
import { createAIBodyHost } from '../../engine/aibody-host.mjs';

test('general team shares run, history and AIBody, resumes without duplicate calls or messages', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-general-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [], replies = ['选择方向', '修正约束', '# 实际脚本\n镜头与口播', '{"pass":true,"issues":[]}'];
  let hold = false;
  initSubagent({ traceDir: path.join(root, 'children'), getDefaultModel: () => ({ provider: 'fixture', id: 'text' }),
    modelReader: () => ({ fixture: { models: [{ id: 'text', baseUrl: 'https://fake.invalid' }] } }),
    resolveAuth: () => ({ baseUrl: 'https://fake.invalid' }), authReader: () => ({ fixture: { type: 'api_key', key: 'test' } }),
    httpFetch: async (_url, opts) => {
      requests.push(JSON.parse(opts.body));
      if (hold) await new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
      const reply = replies.shift();
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: requests.at(-1).messages.at(-1).content.startsWith('REVIEW') ? reply : JSON.stringify({ result: reply, evidence: [], confidence: .7 }) } }] }) };
    },
  });
  const entry = { busy: false, modelKey: { provider: 'fixture', id: 'text' }, sm: { fileEntries: [{ message: { role: 'user', content: '不让家人出镜' } }, { message: { role: 'assistant', content: '只拍食物和手部' } }],
    appendMessage(message) { this.fileEntries.push({ message }); } } };
  const runtime = createAIBodyRuntime({ rootDir: path.join(root, 'aibody'), readState: () => ({}) });
  const store = createRunStore({ rootDir: root }), eventLog = createRunEventLog({ rootDir: root });
  t.after(() => eventLog.close());
  const manager = createRunManager({ store, eventLog, instanceId: 'test', executeChat: createGeneralTeamChat({ wsRoot: root,
    openSession: async () => entry, getModel: e => e.modelKey, readMessages: e => e.sm.fileEntries.map(x => x.message), aibodyHost: createAIBodyHost(runtime) }) });
  async function wait(run) {
    for (let i = 0; i < 400; i++) { const r = manager.get(run.id); if (['completed', 'failed', 'stopped'].includes(r.status)) return r; await delay(10); }
    throw new Error('timeout');
  }
  const run = manager.create({ sessionId: 's', clientRequestId: 'one', message: '/team 做探店脚本', workflow: 'team-general' });
  const done = await wait(run);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(r => JSON.stringify(r.messages).includes('不让家人出镜')));
  assert.match(JSON.stringify(done.checkpoint.team.general.history), /不让家人出镜/);
  assert.equal(runtime.getRun(run.id).evidence.subagents, 4);
  assert.equal(runtime.getRun(run.id).status, 'completed');
  assert.equal(eventLog.readAfter(run.id, 0).filter(e => e.type === 'delta').length, 1);
  assert.deepEqual(done.checkpoint.team.general.model, entry.modelKey);
  assert.equal(eventLog.readAfter(run.id, 0).filter(e => e.type === 'model_selected').length, 1);
  store.update(run.id, { status: 'interrupted', resumeAvailable: true }); manager.resume(run.id);
  assert.equal((await wait(run)).status, 'completed');
  assert.equal(requests.length, 4);
  assert.equal(entry.sm.fileEntries.filter(e => e.message.teamRunId === run.id).length, 2);
  hold = true;
  const stopped = manager.create({ sessionId: 's', clientRequestId: 'two', message: '新任务', workflow: 'team-general' });
  for (let i = 0; i < 100 && requests.length === 4; i++) await delay(10);
  manager.stop(stopped.id);
  const result = await wait(stopped);
  assert.equal(result.status, 'stopped'); assert.equal(result.resumeAvailable, true);
  manager.resume(stopped.id);
  assert.equal((await wait(stopped)).status, 'failed');
  assert.equal(requests.length, 5, 'uncertain paid call must not be repeated');
  assert.equal(entry.busy, false);
});
