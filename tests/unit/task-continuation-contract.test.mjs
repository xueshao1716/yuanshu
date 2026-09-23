import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as continuation from '../../engine/task-continuation.mjs';
import { summarizeRun } from '../../engine/run-observability.mjs';
import * as session from '../../engine/yuanshu-session.mjs';

test('automatic batches stay bounded by elapsed time and explicit opt-out', () => {
  for (const value of [undefined, -1, NaN, Infinity, 60 * 60 * 1000]) {
    assert.equal(continuation.continuationLimits({ executionBudgetMs: value }, 20).budgetMs, 1800000);
  }
  assert.equal(continuation.continuationLimits({ maxTurns: 2 }, 2).automatic, false);
  assert.equal(continuation.continuationLimits({ autoContinueTools: false }, 20).automatic, false);
  // The chat handler intentionally supplies both batch size and automatic=true.
  assert.equal(continuation.continuationLimits({ maxTurns: 20, autoContinueTools: true }, 20).automatic, true);
});

test('legacy recovery requires an actual nonempty message array', () => {
  const run = { status: 'failed', error: '本轮已达到 60 轮工具调用的执行上限', resumeAvailable: false,
    checkpoint: { historySnapshot: { v: 1, messages: 'invalid' } } };
  assert.equal(continuation.withLegacyContinuation(run).resumeAvailable, false);
});

test('successful or running continuation does not inherit errors from previous attempts', () => {
  const events = [{ type: 'failed', data: { message: 'old limit' } }, { type: 'resumed' }, { type: 'run_started' }];
  for (const status of ['running', 'completed']) {
    assert.equal(summarizeRun({ status, error: null }, events).error, null);
  }
  assert.equal(summarizeRun({ status: 'failed' }, [...events, { type: 'failed', data: { message: 'new error' } }]).error, 'new error');
});

test('noninteractive callers reject paused partial work instead of parsing it as done', () => {
  assert.equal(typeof continuation.completedTaskText, 'function');
  assert.throws(() => continuation.completedTaskText({ paused: true, pauseReason: 'execution_budget', text: '{"status":"done"}' }), { code: 'execution_paused' });
  assert.throws(() => continuation.completedTaskText({ error: 'unavailable', text: 'partial' }), /unavailable/);
  assert.throws(() => continuation.completedTaskText({ aborted: true, text: 'partial' }), /停止/);
  assert.equal(continuation.completedTaskText({ text: 'verified' }), 'verified');
  const source = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8').split('\n');
  for (const [index, line] of source.entries()) {
    if (line.includes('= await unifiedChat(')) {
      assert.ok(source[index + 1].includes('completedTaskText('), `background caller at ${index + 1} must reject incomplete results`);
    }
  }
});

test('resume does not append the original user or already persisted tools again', () => {
  assert.equal(typeof session.resumePersistenceState, 'function');
  const entries = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'collect' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: '{}' }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'saved' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '任务已暂停' }] } },
  ];
  const state = session.resumePersistenceState(entries, 'collect', true);
  assert.equal(state.userPersisted, true);
  assert.equal(session.resumePersistenceState(entries, 'collect', false).userPersisted, false);
  assert.equal(session.resumePersistenceState(entries, 'other', true).userPersisted, false);
  const saved = [];
  session.persistYuanshuToolTrace({ appendMessage: m => saved.push(m) }, [
    { role: 'user', content: 'collect' },
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'saved' },
    { role: 'assistant', tool_calls: [{ id: 'c2', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'next page' },
  ], state);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].content[0].id, 'c2');
  assert.equal(saved[1].toolCallId, 'c2');
});
