import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRunObservability } from '../../engine/run-observability.mjs';
import { persistYuanshuAssistant } from '../../engine/yuanshu-session.mjs';
import { extractMessages } from '../../engine/session-utils.mjs';
import { mergeMessages } from '../../frontend/src/lib/local-db.ts';
import { StreamAssembler } from '../../frontend/src/lib/stream-assembler.ts';

const requestedModel = { provider: 'stepfun-plan', id: 'step-5-preview' };
const actual = { provider: 'other', id: 'fallback' };
test('selected and successful models are different facts; a failed attempt is not an answer', () => {
  const run = { status: 'failed', input: { model: requestedModel } };
  const failed = deriveRunObservability(run, [{ type: 'model_selected', data: { model: requestedModel } }, { type: 'error', data: { message: 'HTTP 429' } }]);
  assert.deepEqual(failed.requestedModel, requestedModel);
  assert.equal(failed.textModel, null);
  const success = deriveRunObservability({ ...run, status: 'completed' }, [{ type: 'model_selected', data: { model: requestedModel } }, { type: 'model_switched', data: { ...actual, requestedModel } }, { type: 'done', data: { model: actual } }]);
  assert.deepEqual(success.requestedModel, requestedModel);
  assert.deepEqual(success.textModel, actual);
});

test('model provenance survives server persistence, extraction and stale browser cache', () => {
  const saved = [];
  const metadata = { model: actual, requestedModel, engine: 'yuanshu', switchedModel: { ...actual, reason: '空回复', sameModel: false } };
  persistYuanshuAssistant({ appendMessage: m => saved.push(m) }, '新回复', [], metadata);
  const server = extractMessages([{ type: 'message', id: 'm1', timestamp: '2026-09-22T00:00:00Z', message: saved[0] }]);
  assert.deepEqual(server[0].model, actual); assert.deepEqual(server[0].requestedModel, requestedModel);
  assert.equal(server[0].engine, 'yuanshu');
  const merged = mergeMessages([{ ...server[0], model: requestedModel, sessionId: 's', synced: true }], server);
  assert.deepEqual(merged[0].model, actual);
  assert.deepEqual(merged[0].requestedModel, requestedModel);
});

test('replacement response clears rejected text and thinking but retains completed tools', () => {
  const asm = new StreamAssembler(() => {}, { flushDelayMs: 60000 });
  try {
    asm.addDelta('旧回复'); asm.addThink('旧思考'); asm.toolStart({ id: 't', name: 'read' }); asm.toolEnd('t', false, '42');
    asm.replaceResponse('正确回复', '新思考');
    const snap = asm.snapshot();
    assert.equal(snap.text, '正确回复'); assert.equal(snap.think, '新思考');
    assert.equal(snap.conclusion, '正确回复'); assert.equal(snap.tools[0].output, '42');
  } finally { asm.dispose(); }
});
