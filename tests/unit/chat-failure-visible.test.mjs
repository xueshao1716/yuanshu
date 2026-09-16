// ① 失败可见的回归测试。
//
// 背景：pi 通道的失败**不抛异常**——它落一条 { role:"assistant", content:[], stopReason:"error",
// errorMessage } 的记录。此前这条记录不满足 extractMessages 的任何推送条件 → 被静默丢掉，
// 而 server 那边又用 directChat（不带历史）顶一句回答，于是用户看到的是"它失忆了、变傻了"。
// 这里锁三件事：连续失败计数、失败记录要留在历史里、上游报错时不许无历史兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  noteModelFailure, clearModelFailures, modelFailureState, resetModelFailures, modelFailureKey,
} from '../../engine/model-failures.mjs';
import { extractMessages } from '../../engine/session-utils.mjs';

test('连续失败到阈值就标冷却，成功一次即清零', () => {
  resetModelFailures();
  const m = { provider: 'opencode-go', id: 'deepseek-v4.1-flash' };
  const first = noteModelFailure(m, "Cannot read properties of undefined (reading 'length')");
  assert.equal(first.count, 1);
  assert.equal(first.blocked, false, '第一次失败先不封，避免偶发抖动误伤');
  const second = noteModelFailure(m, "Cannot read properties of undefined (reading 'length')");
  assert.equal(second.count, 2);
  assert.equal(second.blocked, true, '连续两次就该冷却回退');
  assert.equal(modelFailureState(m).count, 2);

  assert.equal(clearModelFailures(m), true);
  assert.equal(modelFailureState(m), null, '成功一次就清零，不搞"错一次记一辈子"');

  // 不同模型各算各的
  resetModelFailures();
  noteModelFailure({ provider: 'agnes', id: 'agnes-2.5-flash' }, 'x');
  assert.equal(modelFailureState({ provider: 'opencode-go', id: 'deepseek-v4.1-flash' }), null);
  // 拿不到 key 的输入不记，也不能抛
  assert.deepEqual(noteModelFailure(null), { key: '', count: 0, blocked: false });
  assert.equal(modelFailureKey({ provider: 'x' }), '');
});

test('失败记录不再被静默丢掉：extractMessages 必须带出 error', () => {
  const entries = [
    { type: 'message', id: 'u1', timestamp: '2026-09-16T09:00:00Z', message: { role: 'user', content: [{ type: 'text', text: '在吗' }] } },
    { type: 'message', id: 'a1', timestamp: '2026-09-16T09:00:01Z', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: "Cannot read properties of undefined (reading 'length')" } },
  ];
  const msgs = extractMessages(entries);
  const a = msgs.find(m => m.role === 'assistant');
  assert.ok(a, '空 content 的失败记录必须留下——以前整条被丢掉，用户只看到"它不说话"');
  assert.match(a.error, /reading 'length'/);
  assert.equal(a.stopReason, 'error');

  // 正常的一轮不受影响
  const ok = extractMessages([{ type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } }]);
  assert.equal(ok[0].error, '');
  assert.equal(ok[0].stopReason, null);
});

test('上游报错时不许用"无历史兜底"糊过去（源码契约）', () => {
  const src = fs.readFileSync('server.mjs', 'utf8');
  assert.match(src, /function lastTurnUpstreamError/, '要能区分"上游报错"和"模型真的空回复"');
  assert.match(src, /if \(!sawDelta && !upstream\)/, '上游报错时不能走 directChat 无历史兜底（那是"变傻"的来源）');
  assert.match(src, /noteModelFailure\(effModel, upstream\.errorMessage\)/, '失败要计数');
  assert.match(src, /retryable: true/, '错误事件要标可重试，前端才给得出重试按钮');
  assert.match(src, /writer\.push\("error"/, '失败要推进前端，而不是只写日志');

  const chat = fs.readFileSync('frontend/src/components/ChatArea.tsx', 'utf8');
  assert.match(chat, /onRetry=\{retryFailed\}/, '聊天页要把重试接到消息列表上');
  assert.match(chat, /const retryFailed = /, '重试实现：找这一轮前面那条用户消息重发');
  const msg = fs.readFileSync('frontend/src/components/Message.tsx', 'utf8');
  assert.match(msg, /msg\.error \?/, '失败条要在气泡里渲染出来');
  const turn = fs.readFileSync('frontend/src/components/TurnList.tsx', 'utf8');
  assert.match(turn, /assistantError/, '折叠列表里的轮次状态也要认出"本轮失败"（不然看着像已完成）');
});
