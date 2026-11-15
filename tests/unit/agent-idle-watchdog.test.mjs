import test from 'node:test';
import assert from 'node:assert/strict';
import { watchAgentIdle } from '../../engine/agent-idle-watchdog.mjs';

function fakeAgent() {
  const subs = new Set();
  return {
    aborted: 0,
    abort() { this.aborted++; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(type) { for (const fn of subs) fn({ type }); },
    get subs() { return subs.size; },
  };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('长时间没有事件就 abort 并回调一次', async () => {
  const agent = fakeAgent(); const hits = [];
  const stop = watchAgentIdle(agent, { ms: 40, onIdle: s => hits.push(s) });
  await wait(90);
  assert.equal(agent.aborted, 1);
  assert.deepEqual(hits, [40]);
  stop();
});

test('事件持续到来时不触发', async () => {
  const agent = fakeAgent();
  const stop = watchAgentIdle(agent, { ms: 40 });
  for (let i = 0; i < 5; i++) { await wait(20); agent.emit('message_update'); }
  assert.equal(agent.aborted, 0);
  stop();
});

test('工具执行期间暂停计时，结束后恢复', async () => {
  const agent = fakeAgent();
  const stop = watchAgentIdle(agent, { ms: 40 });
  agent.emit('tool_execution_start');
  await wait(90);
  assert.equal(agent.aborted, 0);
  agent.emit('tool_execution_end');
  await wait(90);
  assert.equal(agent.aborted, 1);
  stop();
});

test('stop 后取消订阅且不再触发', async () => {
  const agent = fakeAgent();
  const stop = watchAgentIdle(agent, { ms: 30 });
  stop();
  await wait(60);
  assert.equal(agent.aborted, 0);
  assert.equal(agent.subs, 0);
});
