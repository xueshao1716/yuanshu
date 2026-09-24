import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as events from '../../frontend/src/lib/run-events.ts';
import { buildWorkExplanation } from '../../engine/work-explanation.mjs';
import { buildRunSnapshot } from '../../engine/run-observability.mjs';

test('automatic recovery safety barrier is a pause, not model failure', () => {
  const result = events.interruptionNotice({ reason: 'recovery_blocked', message: '自动接续已暂停，请检查运行记录' });
  assert.equal(result.error, undefined);
  assert.match(result.note, /已暂停/);
});

test('预算暂停在流式和刷新恢复中都不是红色失败，重启仍有真实提示', () => {
  assert.equal(typeof events.interruptionNotice, 'function');
  for (const data of [{ reason: 'execution_budget', message: '已暂停，继续任务' }, { pauseReason: 'execution_budget', pauseMessage: '已暂停，继续任务' }]) {
    const result = events.interruptionNotice(data);
    assert.equal(result.error, undefined); assert.match(result.note, /已暂停/);
  }
  assert.match(events.interruptionNotice({ reason: 'server_restarted' }).error, /服务重启/);
});

test('工作状态解释和健康指标区分安全暂停与失败', () => {
  const run = { id: 'r', status: 'interrupted', pauseReason: 'execution_budget', pauseMessage: '时间预算已用完，任务已暂停', resumeAvailable: true };
  const explanation = buildWorkExplanation(run);
  assert.equal(explanation.status.label, '已暂停，可继续');
  assert.match(explanation.status.detail, /时间预算/);
  assert.equal(explanation.problem, '');
  assert.match(explanation.nextStep, /继续任务/);
  assert.equal(buildRunSnapshot([run]).health.failedCount, 0);
});

test('聊天收尾先处理暂停，所有替代模型和只读路径也接通，前端复用暂停解释', () => {
  const source = fs.readFileSync(new URL('../../engine/unified-chat.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('async function finishPausedChat(result)'));
  assert.ok(source.includes('if (result?.paused) { await finishPausedChat(result); return; }'));
  assert.ok(source.includes('if (fb?.paused) { await finishPausedChat(fb); return; }'));
  assert.ok(source.includes('if (proResult?.paused) { await finishPausedChat(proResult); return; }'));
  const ui = fs.readFileSync(new URL('../../frontend/src/components/ChatArea.tsx', import.meta.url), 'utf8');
  assert.ok(ui.includes('interruptionNotice(d)'));
  assert.ok(ui.includes('interruptionNotice(run)'));
});
