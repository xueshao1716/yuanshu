import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createTeamLauncher } from '../../engine/team-launch.mjs';
import { createTeamChat } from '../../engine/team-chat.mjs';
import { createRunStore } from '../../engine/run-store.mjs';
import { createRunEventLog } from '../../engine/run-event-log.mjs';
import { createRunManager } from '../../engine/run-manager.mjs';
import { createAIBodyRuntime } from '../../engine/aibody-runtime.mjs';
import { createAIBodyHost } from '../../engine/aibody-host.mjs';
import { initSubagent } from '../../engine/subagent.mjs';
import { createTeamCompletion } from '../../engine/team-completion.mjs';

test('real child workflow → shared run/events/AIBody → original chat → follow-up context', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-chat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prompts = [];
  let hold = false;
  const final = { title: '青色行走', aspect: '9:16', total_sec: 10, consistencyKey: '同一人物', negative: ['变形'], text_handling: '不添加文字',
    shots: [1, 2, 3].map(no => ({ no, sec: no === 3 ? 4 : 3, shot_size: '近景', camera: '推进', angle: '平视', desc: '青色背景人物行走', prompt: '青色背景人物行走' })) };
  const reply = { ...final, final, unresolved: [], complexity: 'MED', deliverables: ['脚本'],
    rulings: [{ issue: '镜头选择', winner: 'VIDEO', reason: '符合时长' }], issues: [], conflicts: [],
    items: Array.from({ length: 12 }, (_, i) => ({ id: `V-${String(i + 1).padStart(2, '0')}`, pass: true, note: '模拟检查' })) };
  initSubagent({ traceDir: path.join(root, 'children'),
    modelReader: () => ({ fixture: { models: [{ id: 'fixture-model', baseUrl: 'https://fake.invalid' }] } }),
    resolveAuth: () => ({ baseUrl: 'https://fake.invalid' }), authReader: () => ({ fixture: { key: 'test' } }),
    httpFetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) }),
  });
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/models') return res.end(JSON.stringify({ models: [{ provider: 'fixture', id: 'fixture-model' }] }));
    if (req.url === '/api/team/complete') {
      const body = JSON.parse(raw); prompts.push(body.message); if (hold) return;
      try { return res.end(JSON.stringify(await createTeamCompletion({ launcher })(body))); }
      catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
    }
    if (req.url === '/api/pending') return res.end(JSON.stringify({ ok: true, id: 'pfixture' }));
    res.writeHead(404); res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const entry = { busy: false, sm: { fileEntries: [{ message: { role: 'user', content: '必须用青色背景' } }],
    appendMessage(message) { this.fileEntries.push({ message }); } } };
  const launcher = createTeamLauncher({ wsRoot: root, repoRoot: process.cwd(), port: server.address().port, token: 'fixture' });
  const runtime = createAIBodyRuntime({ rootDir: path.join(root, 'aibody'), readState: () => ({}) });
  const execute = createTeamChat({ launcher, wsRoot: root, openSession: async () => entry,
    readMessages: e => e.sm.fileEntries.map(x => x.message), aibodyHost: createAIBodyHost(runtime), pollMs: 5 });
  const store = createRunStore({ rootDir: root });
  const eventLog = createRunEventLog({ rootDir: root }); t.after(() => eventLog.close());
  const manager = createRunManager({ store, eventLog, executeChat: execute, instanceId: 'test' });
  async function wait(run) {
    for (let i = 0; i < 600; i++) {
      const value = manager.get(run.id);
      if (['completed', 'failed', 'stopped'].includes(value.status)) return value;
      await delay(10);
    }
    throw new Error('timeout');
  }
  const run = manager.create({ sessionId: 'same-session', clientRequestId: 'first', message: '/team 写一个10秒视频脚本' });
  const finished = await wait(run);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(launcher.status().runId, run.id);
  assert.ok(prompts.every(p => p.includes('必须用青色背景')), 'all roles share the scoped task context');
  const events = eventLog.readAfter(run.id, 0);
  assert.ok(events.filter(e => e.type === 'subagent_finished').length >= 7);
  assert.ok(runtime.getRun(run.id).evidence.subagents >= 7);
  assert.equal(runtime.getRun(run.id).status, 'completed');
  assert.ok(entry.sm.fileEntries.at(-1).message.content[0].text.includes('青色行走'));
  assert.ok(events.findIndex(e => e.type === 'session_updated') < events.findIndex(e => e.type === 'completed'));
  const count = prompts.length;
  const next = manager.create({ sessionId: 'same-session', clientRequestId: 'second', message: '/team 保留青色背景，修改为雨中行走' });
  assert.equal((await wait(next)).status, 'completed');
  assert.ok(prompts.slice(count).every(p => p.includes('青色行走')), 'follow-up inherits the previous delivered draft');
  assert.equal(entry.sm.fileEntries.filter(e => e.message.teamRunId === run.id).length, 2);
  assert.equal(entry.busy, false);
  const callsBeforeRecovery = prompts.length;
  store.update(next.id, { status: 'interrupted', resumeAvailable: true });
  manager.resume(next.id);
  assert.equal((await wait(next)).status, 'completed');
  assert.equal(prompts.length, callsBeforeRecovery, 'completed child must not repeat paid calls after parent recovery');
  assert.equal(entry.sm.fileEntries.filter(e => e.message.teamRunId === next.id).length, 2);

  hold = true;
  const stopped = manager.create({ sessionId: 'same-session', clientRequestId: 'stop', message: '/team 停止测试视频' });
  for (let i = 0; i < 300 && prompts.length === callsBeforeRecovery; i++) await delay(10);
  assert.ok(prompts.length > callsBeforeRecovery);
  manager.stop(stopped.id);
  const stoppedResult = await wait(stopped);
  assert.equal(stoppedResult.status, 'stopped');
  assert.equal(runtime.getRun(stopped.id).status, 'cancelled');
  assert.equal(stoppedResult.resumeAvailable, true, 'shared task offers checkpoint recovery');
  const callsBeforeResume = prompts.length;
  manager.resume(stopped.id);
  assert.equal((await wait(stopped)).status, 'failed', 'uncertain stage requires reconciliation');
  assert.equal(prompts.length, callsBeforeResume, 'uncertain paid call never silently repeated');
  assert.equal(entry.sm.fileEntries.filter(e => e.message.teamRunId === stopped.id && e.message.role === 'assistant').length, 0);
  assert.equal(runtime.getRun(stopped.id).status, 'failed', 'AIBody follows resumed execution');
});
