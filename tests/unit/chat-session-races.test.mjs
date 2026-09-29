import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatFunction, chatEffect, deferred } from '../helpers/chat-function.mjs';
import { hookRuntime } from '../helpers/hook-runtime.mjs';

function owner() {
  const viewOwnerRef = { current: 'A:1' }, sessionIdRef = { current: 'A' };
  return { viewOwnerRef, sessionIdRef, viewOwner: 'A:1',
    isCurrentView: () => viewOwnerRef.current === 'A:1' && sessionIdRef.current === 'A',
    switchTo(id, generation = 2) { sessionIdRef.current = id; viewOwnerRef.current = `${id}:${generation}`; } };
}
test('A本地写入晚到不能追加进B列表，持久化仍属于A', async () => {
  const env = owner(), pending = deferred(); let saved, list = [{ id: 'b1' }];
  const save = chatFunction('saveToLocal', { ...env, saveMessage: async m => { saved = m; await pending.promise; }, setLocalMessages: update => { list = update(list); } });
  const work = save({ id: 'a1', role: 'assistant', text: 'A回复' });
  env.switchTo('B'); pending.resolve(); await work;
  assert.equal(saved.sessionId, 'A'); assert.deepEqual(list.map(m => m.id), ['b1']);
});
test('A→B→A后旧保存回调也不能覆盖新视图', async () => {
  const env = owner(), pending = deferred(); let writes = 0;
  const save = chatFunction('saveToLocal', { ...env, saveMessage: () => pending.promise, setLocalMessages: () => { writes++; } });
  const work = save({ id: 'a1' }); env.switchTo('B'); env.switchTo('A', 3); pending.resolve(); await work;
  assert.equal(writes, 0);
});
function sendEnv() {
  const env = owner(), pending = deferred(), connected = [], saved = [], errors = [];
  const streamRef = { current: null }, assistantMsgIdRef = { current: null };
  const scope = { ...env, currentSessionId: 'A', currentModel: 'auto/auto', streamRef, assistantMsgIdRef,
    speech: { stop() {} }, localStorage: { setItem() {}, getItem() { return null; } },
    wasBackgroundRef: { current: false }, appendMessage() {}, setStream() {}, makeAssembler() {}, scroll() {},
    emptyStream: () => ({ text: '', tools: [], notes: [] }), RunsApi: { create: () => pending.promise },
    saveActiveRun: r => saved.push(r), connectRun: r => connected.push(r),
    updStream: f => errors.push(f), finalize: () => errors.push('finalized'), friendlyStreamError: s => s,
  };
  return { env, scope, pending, connected, saved, errors, streamRef, assistantMsgIdRef, send: chatFunction('send', scope) };
}
test('任务创建慢返回：保持A的消息身份，不接管B的流', async () => {
  const h = sendEnv(), work = h.send('原问题'), originalId = h.assistantMsgIdRef.current;
  h.env.switchTo('B'); h.assistantMsgIdRef.current = 'b-assistant'; h.streamRef.current = { text: 'B的流' };
  h.pending.resolve({ runId: 'run-A', lastSeq: 0, status: 'running' }); await work;
  assert.equal(h.connected.length, 0);
  assert.equal(h.saved.length, 1); assert.equal(h.saved[0].sessionId, 'A');
  assert.equal(h.saved[0].assistantMessageId, originalId); assert.equal(h.saved[0].stream.text, '');
});
test('任务创建失败晚到不收尾别的会话', async () => {
  const h = sendEnv(), work = h.send('原问题'); h.env.switchTo('B'); h.pending.reject(new Error('offline')); await work;
  assert.equal(h.errors.length, 0);
});
test('本地缓存、流状态在切换首帧就隔离，旧setter失效', () => {
  const h = hookRuntime(new URL('../../frontend/src/hooks/useViewState.ts', import.meta.url), 'useViewState');
  let state = h.render('A:1'); state[1]('A data'); state = h.render();
  assert.equal(state[0], 'A data'); const oldSet = state[1];
  state = h.render('B:2'); assert.equal(state[0], undefined);
  state[1]('B data'); oldSet('late A'); state = h.render(); assert.equal(state[0], 'B data');
  state = h.render('A:3'); assert.equal(state[0], undefined);
  oldSet('stale A'); state = h.render(); assert.equal(state[0], undefined);
});

function firstSend() {
  const h = sendEnv(), creation = deferred(), selected = [];
  h.env.switchTo('', 1);
  const pendingSendRef = { current: null }, creatingSessionRef = { current: false };
  const scope = { ...h.scope, currentSessionId: null, pendingSendRef, creatingSessionRef,
    isCurrentView: () => h.env.viewOwnerRef.current === ':1',
    SessionsApi: { create: () => creation.promise }, refreshSessions() {},
    selectSession: id => selected.push(id), toast() {} };
  return { h, creation, selected, pendingSendRef, scope, send: chatFunction('send', scope) };
}
test('首条消息等新会话渲染后再发，使用新视图而非80ms旧闭包', async () => {
  const f = firstSend(); let oldWrites = 0;
  f.scope.appendMessage = () => { oldWrites++; };
  const work = chatFunction('send', f.scope)('首条问题', [{ name: 'test.txt' }]);
  f.h.pending.resolve({ runId: 'first', status: 'running' });
  f.creation.resolve({ id: 'NEW' }); await work;
  assert.equal(oldWrites, 0, 'old view must not publish optimistic messages');
  assert.deepEqual(f.selected, ['NEW']);
  assert.equal(f.pendingSendRef.current?.raw, '首条问题');
  const sent = [];
  chatFunction('flushPendingSend', { pendingSendRef: f.pendingSendRef, currentSessionId: 'NEW', send: (...a) => sent.push(a) })();
  assert.equal(sent[0][0], '首条问题'); assert.equal(sent[0][1][0].name, 'test.txt');
  assert.equal(f.pendingSendRef.current, null);
});
test('创建会话期间切到B，迟到的创建结果不能抢回页面或发消息', async () => {
  const f = firstSend(), work = f.send('首条问题');
  f.h.env.switchTo('B'); f.h.pending.resolve({ runId: 'first', status: 'running' }); f.creation.resolve({ id: 'NEW' }); await work;
  assert.equal(f.selected.length, 0); assert.equal(f.pendingSendRef.current, null);
});

test('旧任务恢复请求失败不能清掉新任务或短暂断网时的恢复记录', async () => {
  const pending = deferred(), activeRunRef = { current: null }, cleared = [];
  const cleanup = chatEffect('const restore = async', {
    currentSessionId: 'A', loadActiveRun: () => ({ runId: 'old-A' }),
    RunsApi: { get: () => pending.promise }, activeRunRef,
    clearActiveRun: id => cleared.push(id), streamCloseRef: { current: null },
  })();
  activeRunRef.current = { runId: 'new-A' };
  pending.reject(new Error('temporary network failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cleared, []);
  cleanup();
});
