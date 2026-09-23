import test from 'node:test';
import assert from 'node:assert/strict';
const helpers = await import('../helpers/replay-turn.mjs').catch(() => ({}));

test('历史会话继续聊天后，生图回放仍定位原始工具所在用户轮次', () => {
  assert.equal(typeof helpers.historyForRun, 'function');
  const original = [{ role: 'user', id: 'u1' }, { role: 'assistant', tools: [{ id: 'draw' }] },
    { role: 'assistant', tools: [{ id: 'download' }] }, { role: 'assistant', images: ['local-image'] }];
  const history = [...original, { role: 'user', id: 'u2' }, { role: 'assistant', images: ['another-image'] }];
  const events = [{ type: 'tool', data: { id: 'draw' } }, { type: 'tool', data: { id: 'download' } }];
  assert.deepEqual(helpers.historyForRun(history, events), original);
});

test('工具证据缺失或跨越用户轮次时，回放失败而不是猜测最新轮次', () => {
  assert.equal(typeof helpers.historyForRun, 'function');
  const events = [{ type: 'tool', data: { id: 'draw' } }, { type: 'tool', data: { id: 'download' } }];
  assert.throws(() => helpers.historyForRun([{ role: 'user' }], events));
  assert.throws(() => helpers.historyForRun([{ role: 'user' }, { role: 'assistant', tools: [{ id: 'draw' }] },
    { role: 'user' }, { role: 'assistant', tools: [{ id: 'download' }] }], events));
});
