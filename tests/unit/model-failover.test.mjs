import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyModelFailure, planRetry, withModelFailover } from '../../engine/model-failover.mjs';

const err = (msg) => Object.assign(new Error(msg), {});

test('分类：额度 / 网络 / 模型选错 / 其它', () => {
  assert.equal(classifyModelFailure(err('HTTP 429: 您已达到每周/每月使用上限')), 'quota');
  assert.equal(classifyModelFailure(err('HTTP 401: unauthorized')), 'quota');
  assert.equal(classifyModelFailure(err('fetch failed')), 'network');
  assert.equal(classifyModelFailure(err('socket hang up')), 'network');
  assert.equal(classifyModelFailure(err('HTTP 400: Model agnes-video-2.5-flash is a video model')), 'bad-model');
  assert.equal(classifyModelFailure(err('tool execution failed')), 'other');
});

test('决策：额度换通道、网络同模型退避、其它不重试、超限放弃', () => {
  assert.deepEqual(planRetry('quota', 1).switchModel, true);
  assert.deepEqual(planRetry('network', 1).switchModel, false);
  assert.equal(planRetry('other', 1).retry, false);
  assert.equal(planRetry('quota', 3, { maxAttempts: 3 }).retry, false);
});

test('额度失败 → 换下一个文本模型并成功', async () => {
  const A = { provider: 'agnes', id: 'agnes-2.5-flash' };
  const B = { provider: 'zai-coding-cn', id: 'glm-5.3-flash' };
  const switched = [];
  const out = await withModelFailover({
    initial: A,
    call: async (m) => { if (m.id === A.id) throw err('HTTP 429: 使用上限'); return { text: `ok from ${m.id}` } },
    pickNext: () => B,
    onSwitch: (s) => switched.push(s.to.id),
  });
  assert.equal(out.model.id, B.id);
  assert.equal(out.attempts, 2);
  assert.deepEqual(switched, [B.id]);
});

test('网络失败 → 同模型退避重试，不换通道', async () => {
  const A = { provider: 'agnes', id: 'agnes-2.5-flash' };
  const calls = [];
  const out = await withModelFailover({
    initial: A,
    call: async (m) => { calls.push(m.id); if (calls.length < 2) throw err('fetch failed'); return { text: 'ok' } },
    pickNext: () => { throw new Error('不该换通道') },
    sleep: async () => {},
  });
  assert.equal(out.attempts, 2);
  assert.deepEqual(calls, [A.id, A.id]);
});

test('媒体模型不会被选为备胎；没有备胎时如实报错', async () => {
  const A = { provider: 'agnes', id: 'agnes-2.5-flash' };
  await assert.rejects(() => withModelFailover({
    initial: A,
    call: async () => { throw err('HTTP 429 使用上限') },
    pickNext: () => ({ provider: 'agnes', id: 'agnes-video-2.5-flash' }),
  }), /不是文本模型/);

  await assert.rejects(() => withModelFailover({
    initial: A,
    call: async () => { throw err('HTTP 429 使用上限') },
    pickNext: () => undefined,
  }), /没有可切换的通道/);
});

test('内容类错误不重试（避免把内容错误当成通道问题反复烧钱）', async () => {
  let n = 0;
  await assert.rejects(() => withModelFailover({
    initial: { provider: 'x', id: 'glm-5.3-flash' },
    call: async () => { n++; throw err('tool execution failed: bad args') },
    pickNext: () => ({ provider: 'y', id: 'agnes-2.5-flash' }),
  }), /bad args/);
  assert.equal(n, 1);
});
