// 灵魂为主、记忆/外观.md 为辅：合并规则（2026-11-08）
//
// 主 = 人格定义四项（appearance / hairstyle / clothing / scenarioOutfits）
// 辅 = 记忆/外观.md 的行
// 规则：主有该项就用主；主缺才用辅；辅里主没写的细节作为「补充」并标来源；冲突（定形说法）不追加。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeAppearance, parseAuxLines } from '../../engine/appearance-merge.mjs';
import { buildIdentityPrompt } from '../../engine/companion-appearance.mjs';
import { buildSelfModel, renderSelfMarkdown } from '../../engine/self-model.mjs';

const MAIN = {
  appearance: '20 岁上下的中国女生，皮肤白净偏冷调，眼睛偏大而清亮。',
  hairstyle: '齐耳短发，深棕近黑，发尾自然内扣。',
  clothing: '修身短款灰色针织上衣，高腰黑色直筒短裤。',
  scenarioOutfits: '工作：针织上衣袖子推到肘部。',
};

const AUX = [
  '及肩深色短发，发梢泛星空蓝光',
  '眼睛温暖明亮，笑起来有一点弯',
  '深色连帽衫，领口一枚发光圆形徽章',
  '整体安静温暖，赛博朋克 × 治愈系，高质量插画，柔和光晕',
];

const texts = (merged) => merged.supplements.map((s) => s.text);

test('主四项都有：四项用主的原文，辅不覆盖任何一项', () => {
  const merged = mergeAppearance({ main: MAIN, aux: AUX });
  assert.deepEqual(merged.primary, MAIN);
  assert.deepEqual(merged.sources, {
    appearance: 'main', hairstyle: 'main', clothing: 'main', scenarioOutfits: 'main',
  });
  assert.equal(merged.text.includes('补自'), false, '主写了的项不该标"补自"');
  for (const value of Object.values(MAIN)) assert.ok(merged.text.includes(value), `主项丢失：${value}`);
});

test('主缺某一项：才用辅的对应项顶上，并在 text 里标来源', () => {
  const main = { ...MAIN, hairstyle: '' };
  const merged = mergeAppearance({ main, aux: AUX });
  assert.equal(merged.sources.hairstyle, 'aux');
  assert.ok(merged.primary.hairstyle.includes('及肩深色短发'));
  assert.ok(merged.primary.hairstyle.includes('发梢泛星空蓝光'));
  assert.match(merged.text, /发型与发色（补自 记忆\/外观\.md）：及肩深色短发/);
  // 它已经成了这一项的正文，就不该再重复出现在补充里
  assert.equal(texts(merged).some((t) => t.includes('及肩深色短发')), false);
});

test('主有发型、辅也有发型：只取主，辅的发型定形描述不追加（避免两套头发）', () => {
  const merged = mergeAppearance({ main: MAIN, aux: AUX });
  assert.equal(merged.primary.hairstyle, MAIN.hairstyle);
  assert.equal(texts(merged).some((t) => t.includes('及肩')), false, '不该出现第二套头发');
  assert.equal(merged.text.includes('及肩'), false);
  assert.ok(merged.dropped.some((d) => d.reason === 'conflict' && d.text.includes('及肩')), '被丢掉的原因要留痕');
});

test('辅的细节（发梢光效 / 领口徽章）作为 supplement 追加，带来源', () => {
  const merged = mergeAppearance({ main: MAIN, aux: AUX });
  const supp = texts(merged);
  assert.ok(supp.includes('发梢泛星空蓝光'), '发梢光效应作为补充');
  assert.ok(supp.includes('领口一枚发光圆形徽章'), '徽章应作为补充');
  assert.ok(merged.supplements.every((s) => s.source === '记忆/外观.md'));
  assert.ok(merged.supplements.every((s) => s.kind === 'detail' || s.kind === 'style'));
  assert.match(merged.text, /补充细节（来自 记忆\/外观\.md/);
  // 主在前、补充在后
  assert.ok(merged.text.indexOf('发型与发色：') < merged.text.indexOf('补充细节'));
  // 辅的衣服主体是冲突项，不该被当成补充追加
  assert.equal(supp.some((t) => t.includes('深色连帽衫')), false);
});

test('两边都空：返回空 primary / 空 supplements / 空 text，且不报错', () => {
  for (const input of [{ main: {}, aux: [] }, {}, { main: null, aux: null }, { main: undefined, aux: '' }]) {
    const merged = mergeAppearance(input);
    assert.deepEqual(merged.primary, { appearance: '', hairstyle: '', clothing: '', scenarioOutfits: '' });
    assert.deepEqual(merged.supplements, []);
    assert.equal(merged.text, '');
    assert.deepEqual(merged.dropped, []);
  }
});

test('出图母提示词：主在前、补充在后；辅的冲突发型不进提示词', () => {
  const prompt = buildIdentityPrompt(MAIN, { aux: AUX });
  assert.match(prompt, /人物外貌：20 岁上下的中国女生/);
  assert.match(prompt, /发梢泛星空蓝光/);
  assert.equal(prompt.includes('及肩'), false);
  assert.ok(prompt.indexOf('齐耳短发') < prompt.indexOf('发梢泛星空蓝光'), '主应排在补充之前');
  for (const must of ['不是动漫、卡通或CG', '不做色情化呈现', '禁止塑料磨皮']) {
    assert.ok(prompt.includes(must), `缺不可协商约束：${must}`);
  }
});

test('记忆/自我.md：主四项逐项落地，补充细节标「（补充）」', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '记忆'), { recursive: true });
  fs.writeFileSync(path.join(root, '记忆', '人格定义.json'), JSON.stringify({
    version: 1, name: '小语', age: 20, gender: '女性', called: '伙伴', bond: '知己',
    inner: ['我有自己的判断'], boundaries: ['人格只读'], growth: '批准后演化。', ...MAIN,
  }), 'utf8');
  fs.writeFileSync(path.join(root, '记忆', '外观.md'), `<!-- 补充外观 -->\n${AUX.join('\n')}\n`, 'utf8');

  const md = renderSelfMarkdown(buildSelfModel({ wsRoot: root }));
  assert.ok(md.includes(`- 人物外貌：${MAIN.appearance}`));
  assert.ok(md.includes(`- 发型与发色：${MAIN.hairstyle}`));
  assert.ok(md.includes('- （补充）发梢泛星空蓝光'));
  assert.ok(md.includes('- （补充）领口一枚发光圆形徽章'));
  assert.ok(md.includes('记忆/外观.md'));
  assert.ok(md.indexOf('- 发型与发色：') < md.indexOf('- （补充）发梢泛星空蓝光'), '补充应在主项之后');
});

test('parseAuxLines：注释与标题不算外观', () => {
  const lines = parseAuxLines('<!-- a\nb -->\n# 外观\n- 深色连帽衫\n\n及肩深色短发\n');
  assert.deepEqual(lines, ['深色连帽衫', '及肩深色短发']);
});
