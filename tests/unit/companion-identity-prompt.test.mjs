import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import('../../engine/companion-appearance.mjs');

test('出图母提示词：形象四项来自人格定义，不再是硬编码', async () => {
  const { buildIdentityPrompt } = await mod();
  const prompt = buildIdentityPrompt({
    appearance: '20 岁上下的中国女生，皮肤白净偏冷调',
    hairstyle: '齐耳短发，深棕近黑',
    clothing: '雾蓝灰连帽卫衣',
    scenarioOutfits: '工作：袖子推得更高',
  });
  assert.match(prompt, /皮肤白净偏冷调/);
  assert.match(prompt, /齐耳短发，深棕近黑/);
  assert.match(prompt, /雾蓝灰连帽卫衣/);
  assert.match(prompt, /袖子推得更高/);
  // 与旧硬编码描述冲突的部分不该再出现
  assert.doesNotMatch(prompt, /腰下超长直黑发/);
});

test('出图母提示词：风格与安全约束不可协商，只换描述部分', async () => {
  const { buildIdentityPrompt } = await mod();
  const prompt = buildIdentityPrompt({ appearance: '短发' });
  for (const must of ['不是动漫、卡通或CG', '真人摄影质感', '不做色情化呈现', '禁止塑料磨皮', '不改变这个人的身份与基础外观']) {
    assert.ok(prompt.includes(must), `缺约束：${must}`);
  }
});

test('四项都空时退回原常量（不能因为没填就丢风格与安全约束）', async () => {
  const { buildIdentityPrompt, COMPANION_IDENTITY_PROMPT } = await mod();
  assert.equal(buildIdentityPrompt({}), COMPANION_IDENTITY_PROMPT);
  assert.equal(buildIdentityPrompt(null), COMPANION_IDENTITY_PROMPT);
  assert.equal(buildIdentityPrompt({ appearance: '   ' }), COMPANION_IDENTITY_PROMPT);
});
