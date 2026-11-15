import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createGeneralTeamChat } from '../../engine/team-general-chat.mjs';
import { createTeamRunRead } from '../../engine/team-run-read.mjs';
import { initSubagent } from '../../engine/subagent.mjs';
import { createRunStore } from '../../engine/run-store.mjs';
import { createRunEventLog } from '../../engine/run-event-log.mjs';
import { createRunManager } from '../../engine/run-manager.mjs';
import { createAIBodyRuntime } from '../../engine/aibody-runtime.mjs';
import { createAIBodyHost } from '../../engine/aibody-host.mjs';

const textOf = message => (message?.content || []).map(block => block.text || '').join('\n');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-general-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [], replies = [
    '方向：先讲价格，再讲份量。',
    '质疑：预算与购买规则没有写清。',
    '初稿：0—3秒；画面：货架；口播：“先看价格。”',
    '{"pass":false,"issues":["缺少预算依据"]}',
    '修订稿：0—3秒；画面：货架；口播：“先看价格，再算预算。”',
    '{"pass":false,"issues":["预算依据仍缺失"],"revisionChecks":[{"id":"R1","status":"unresolved","quote":"","reason":"新稿仍未写出预算依据"}]}',
  ];
  initSubagent({ traceDir: path.join(root, 'children'), getDefaultModel: () => ({ provider: 'fixture', id: 'text' }),
    modelReader: () => ({ fixture: { models: [{ id: 'text', baseUrl: 'https://fake.invalid' }] } }),
    resolveAuth: () => ({ baseUrl: 'https://fake.invalid' }), authReader: () => ({ fixture: { type: 'api_key', key: 'test' } }),
    httpFetch: async (_url, opts) => {
      requests.push(JSON.parse(opts.body));
      const reply = replies.shift();
      const payload = requests.at(-1).messages.at(-1).content.startsWith('REVIEW')
        ? reply : JSON.stringify({ result: reply, evidence: [], confidence: .7 });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: payload } }] }) };
    },
  });
  const entry = { busy: false, modelKey: { provider: 'fixture', id: 'text' },
    sm: { fileEntries: [{ message: { role: 'user', content: '之前的上下文' } }, { message: { role: 'assistant', content: '好的' } }],
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
  return { root, entry, requests, manager, wait };
}

test('content gate failure is not resumable and leaves a visible assistant record', async t => {
  const f = await fixture(t);
  const run = f.manager.create({ sessionId: 's', clientRequestId: 'gate', message: '/team 写一条带货脚本', workflow: 'team-general' });
  const failed = await f.wait(run);
  assert.equal(failed.status, 'failed');
  assert.match(String(failed.error), /^正文复核未通过/);
  assert.equal(failed.resumeAvailable, false, 'replaying the stored review stage cannot fix a content rejection');

  // resume must not silently replay the same stages into the same error.
  const before = f.requests.length;
  assert.equal(f.manager.resume(run.id).status, 'failed');
  await f.wait(run);
  assert.equal(f.requests.length, before, 'no paid stage may be replayed by a dead-end resume');

  // The failure must exist in the session, not only in run events.
  const entries = f.entry.sm.fileEntries.filter(e => e.message.teamRunId === run.id);
  assert.deepEqual(entries.map(e => e.message.role), ['user', 'assistant']);
  const text = textOf(entries[1].message);
  assert.match(text, /^天团失败：正文复核未通过/);
  assert.match(text, /不能续跑/);

  // The workbench snapshot must point at this run instead of the old video run.
  const snapshotFile = path.join(f.root, '工程/多AI角色扮演系统/team-run-general.json');
  assert.equal(fs.existsSync(snapshotFile), true, 'general runs must publish a workbench snapshot');
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  assert.equal(snapshot.runId, run.id);
  assert.equal(snapshot.status, 'failed');
  const read = createTeamRunRead({ wsRoot: f.root, json: (_res, status, body) => ({ status, ...body }), getLaunch: () => null });
  const view = read({});
  assert.equal(view.status, 200);
  assert.equal(view.run?.runId, run.id);
  assert.equal(view.snapshotKind, 'current');
});
