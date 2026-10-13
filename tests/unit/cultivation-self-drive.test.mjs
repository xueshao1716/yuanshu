// 灵魂自我驱动边界（2026-10-11）：bounded 封套内 policy.set 母亲身份可自执行；越线仍必须人类。
import test from 'node:test';
import assert from 'node:assert/strict';
import { controlFixture, draft, enabledPolicy } from '../helpers/cultivation-fixture.mjs';

const preset = (over = {}) => {
  const day = 86400000;
  // fixture 的 enabledPolicy 是"2027 到期"的旧签，self-drive 用当前时间的 30 天封套
  const p = { ...enabledPolicy(), maxAgents: 10, maxConcurrent: 2, dailyRequests: 300, dailyBudgetCents: 1000,
    allowRemote: true, timeoutMs: 600000, dataScopes: ['knowledge:approved-cultivation'],
    expiresAt: new Date(Date.now() + 30 * day - 3600000).toISOString(), motherLearning: false };
  return { ...p, ...over };
};

test('母亲身份可自行开启标准受限预设', async t => {
  const f = await controlFixture(t);
  const receipt = await f.execute(f.command('policy.set', { policy: preset() }), 'mother');
  assert.equal(receipt.result.id, 'control');
  assert.equal(f.store.read('control').data.policy.enabled, true);
});

test('母亲身份可自行暂停（enabled=false 且不开母体学习）', async t => {
  const f = await controlFixture(t);
  await f.execute(f.command('policy.set', { policy: preset() }), 'mother');
  const pause = { ...preset(), enabled: false, motherLearning: false };
  await f.execute(f.command('policy.set', { policy: pause }), 'mother');
  assert.equal(f.store.read('control').data.policy.enabled, false);
});

test('越线全部拒绝母亲：加工具/开母体学习/加倍额度/拖长有效期/扩数据范围', async t => {
  const f = await controlFixture(t);
  const cases = {
    '加工具': preset({ tools: ['run_code'] }),
    '母体学习': preset({ motherLearning: true }),
    '超预算': preset({ dailyBudgetCents: 1100 }),
    '超次数': preset({ dailyRequests: 301 }),
    '超个体': preset({ maxAgents: 11 }),
    '拖长有效期': preset({ expiresAt: new Date(Date.now() + 60 * 86400000).toISOString() }),
    '扩数据范围': preset({ dataScopes: ['knowledge:approved-cultivation', 'knowledge:all'] }),
    '递归': preset({ recursive: true }),
    '超并发': preset({ maxConcurrent: 4 }),
    '超时加长': preset({ timeoutMs: 900000 }),
    '多模型9个': preset({ models: ['a','b','c','d','e','f','g','h','i'] }),
  };
  for (const [name, policy] of Object.entries(cases)) {
    await assert.rejects(() => f.execute(f.command('policy.set', { policy }), 'mother'),
      /identity_denied/, `${name} 必须仍要人类`);
  }
});

test('人类身份对封套内外都有权（原有契约不回退），母亲被封套外的 enabledPolicy 拒绝', async t => {
  const f = await controlFixture(t);
  await f.execute(f.command('policy.set', { policy: enabledPolicy() }), 'human'); // fixture 老签（2027 到期）超出封套，但人类可以
  await assert.rejects(() => f.execute(f.command('policy.set', { policy: enabledPolicy() }), 'mother'), /identity_denied/);
});

test('全量 policy.set 封套判定不再引入 mother 通道给其他动作', async t => {
  const f = await controlFixture(t);
  const registered = await f.register();
  // 2026-10-14 自己培养的个体：母亲可暂停
  await f.execute(f.command('agent.pause', { agentId: registered.agentId }), 'mother');
  assert.equal(f.controls.read().data.agents[0].status, 'paused');
});
