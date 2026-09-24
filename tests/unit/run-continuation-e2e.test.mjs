import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { unifiedChat, initUnifiedChat } from '../../engine/unified-chat.mjs';
import { initDshKeys } from '../../engine/dsh-keys.mjs';
import { createRunManager } from '../../engine/run-manager.mjs';
import { createRunStore } from '../../engine/run-store.mjs';
import { createRunEventLog } from '../../engine/run-event-log.mjs';
import { createRunEffects } from '../../engine/run-effects.mjs';
import { createRunApi } from '../../engine/run-api.mjs';
import { RUN_SLICE_MS } from '../../engine/run-recovery.mjs';

const LF = String.fromCharCode(10);
const emit = (res, type, data) => res.write('event: ' + type + LF + 'data: ' + JSON.stringify(data) + LF + LF);
async function waitFor(check, describe) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(describe());
}
function subscribe(manager, id, cursor = 0) {
  const req = new EventEmitter(), events = []; req.headers = {};
  const res = { writableEnded: false, writeHead() {}, end() { this.writableEnded = true; },
    write(chunk) { for (const line of String(chunk).split(LF)) if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5))); return true; } };
  createRunApi({ manager, json: () => assert.fail('SSE request failed') }).events(res, req, new URL('http://local/events?after=' + cursor), id);
  return { events, close: () => req.emit('close') };
}

for (const restart of [false, true]) test('real loop + durable recovery + SSE isolation: ' + (restart ? 'new owner' : 'budget pause'), async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-continuation-e2e-'));
  const requests = [], executed = [], scheduled = [], subscriptions = [];
  const release = Promise.withResolvers();
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const task = body.messages.find(message => message.role === 'user').content;
    const resumed = body.messages.some(message => message.role === 'tool');
    if (!resumed) { await release.promise; t.mock.timers.tick(RUN_SLICE_MS + 1); }
    const message = resumed ? { content: task + ' complete' } : { tool_calls: [{ id: task + '-call', type: 'function',
      function: { name: 'lookup', arguments: JSON.stringify({ task }) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: resumed ? 'stop' : 'tool_calls' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = { provider: 'recovery-fixture', id: 'fixture', api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', maxTokens: 8192, contextWindow: 32000 };
  const readJsonFile = file => file === 'auth' ? { [model.provider]: { key: 'fixture' } } : { [model.provider]: { models: [model] } };
  initDshKeys({ authPath: 'auth', modelsPath: 'models', readJsonFile });
  initUnifiedChat({ authPath: 'auth', modelsPath: 'models', readJsonFile, getModelList: () => [model],
    UNIFIED_TOOLS: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { task: { type: 'string' } } } } }],
    executeUnifiedTool: async (name, args, context) => {
      assert.ok(['task-A', 'task-B'].includes(args.task));
      executed.push({ task: args.task, runId: context.runId, sessionId: context.sessionId });
      fs.appendFileSync(path.join(rootDir, args.task + '.txt'), args.task + LF);
      return { text: args.task + ' saved' };
    },
  });
  let store, effects, eventLog, manager;
  function connect(owner) {
    store = createRunStore({ rootDir }); effects = createRunEffects({ rootDir }); eventLog = createRunEventLog({ rootDir });
    manager = createRunManager({ store, effects, eventLog, instanceId: owner, workspaceScope: () => rootDir,
      scheduleRecovery: callback => { const item = { callback, cancelled: false }; scheduled.push(item); return () => { item.cancelled = true; }; },
      executeChat: async (req, res, body) => {
        const ctx = body.__runContext, controller = new AbortController(); req.once('close', () => controller.abort());
        const result = await unifiedChat(model, [{ role: 'user', content: body.message }], {
          signal: controller.signal, effects: ctx.effects, executionBudgetMs: ctx.executionBudgetMs, executionDeadlineAt: ctx.executionDeadlineAt,
          executionContext: { runId: ctx.runId, sessionId: body.sessionId, attempt: ctx.attempt },
          resumeSnapshot: ctx.resume ? ctx.checkpoint.historySnapshot : null, resumeCheckpointKind: ctx.resume ? ctx.checkpoint.checkpointKind : null,
          onCheckpoint: cp => emit(res, 'checkpoint', cp), onDelta: text => emit(res, 'text', { text }),
        });
        if (result.paused) emit(res, 'interrupted', { reason: result.pauseReason, message: result.message });
        else if (result.error) emit(res, 'error', { message: result.error });
        res.end();
      },
    });
  }
  try {
    connect('owner-first');
    const runs = ['A', 'B'].map(id => manager.create({ sessionId: 'session-' + id, clientRequestId: 'request-' + id, message: 'task-' + id }));
    await waitFor(() => requests.length === 2, () => 'provider requests did not start');
    const first = subscribe(manager, runs[0].id); subscriptions.push(first);
    const cursor = first.events.at(-1).seq; first.close(); release.resolve();
    await waitFor(() => runs.every(run => store.get(run.id).backgroundRecovery.state === 'scheduled'), () => JSON.stringify(store.list()));
    for (const run of runs) {
      assert.equal(store.get(run.id).checkpoint.checkpointKind, 'tool_results');
      assert.equal(store.get(run.id).checkpoint.completedSteps.length, 1);
    }
    if (restart) {
      manager.dispose(); eventLog.close(); scheduled.length = 0;
      connect('owner-restarted'); manager.recover();
    }
    const reconnected = subscribe(manager, runs[0].id, cursor); subscriptions.push(reconnected);
    for (const item of scheduled.splice(0)) if (!item.cancelled) item.callback();
    await waitFor(() => runs.every(run => store.get(run.id).status === 'completed'), () => JSON.stringify(store.list()));
    for (const [index, run] of runs.entries()) {
      const task = 'task-' + ['A', 'B'][index];
      assert.equal(fs.readFileSync(path.join(rootDir, task + '.txt'), 'utf8'), task + LF);
      assert.equal(effects.list(run.id).length, 1);
      assert.equal(store.get(run.id).backgroundRecovery.used, 1);
      assert.equal(executed.filter(item => item.runId === run.id && item.sessionId === run.sessionId && item.task === task).length, 1);
      const continued = requests.find(request => request.messages.some(message => message.role === 'tool' && message.content.includes(task)));
      assert.ok(continued, 'persisted tool result reaches next provider request');
      assert.equal(JSON.stringify(continued.messages).includes('task-' + ['B', 'A'][index]), false);
    }
    assert.equal(requests.length, 4); assert.equal(executed.length, 2);
    assert.ok(reconnected.events.length > 0);
    assert.ok(reconnected.events.every(event => event.seq > cursor && event.runId === runs[0].id));
    assert.equal(new Set(reconnected.events.map(event => event.seq)).size, reconnected.events.length);
    assert.equal(reconnected.events.filter(event => event.type === 'completed').length, 1);
    assert.equal(reconnected.events.some(event => event.type === 'interrupted'), false);
  } finally {
    release.resolve(); for (const subscription of subscriptions) subscription.close();
    manager?.dispose(); eventLog?.close(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
