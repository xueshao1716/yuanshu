// 全局创作配色卡（engine/color-prefs.mjs + 各出口的落地）——2026-09-16。
//
// 起因：用户说配色卡"不够全局"。此前它只挂在连续创作项目上（project.colorCardId），
// 于是绘画工坊、视频工坊、聊天里出图都吃不到。这组测试锁住三件事：
//   ① 全局偏好本身能存能读，认不出来的 id 一律拒绝（不留脏数据）
//   ② 所有出图/出片的出口都会把配色的「色调」写进提示词（media-api 是共同出口）
//   ③ 故事层已经写过配色的提示词不会被追加第二次
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initColorPrefs, loadColorPrefs, saveColorPrefs, currentColorCard } from '../../engine/color-prefs.mjs';
import { withGlobalPalette } from '../../engine/media-api.mjs';
import { colorCardPromptBlock } from '../../engine/color-cards.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-color-')), 'color-prefs.json');

test('全局配色：存/读往返，认不出来的 id 直接拒绝', () => {
  const file = tmpFile();
  initColorPrefs(file);
  assert.deepEqual(loadColorPrefs(), { colorCardId: '' }, '没文件时就是"没选"');

  assert.deepEqual(saveColorPrefs({ colorCardId: 'vivid-red-green' }), { colorCardId: 'vivid-red-green' });
  assert.equal(loadColorPrefs().colorCardId, 'vivid-red-green');
  assert.equal(currentColorCard()?.name, '红绿撞色');

  // 脏 id：拒绝，并且不覆盖已有的合法选择
  saveColorPrefs({ colorCardId: '../etc/passwd' });
  assert.equal(loadColorPrefs().colorCardId, '', '不认识的 id 一律当没选');
  saveColorPrefs({ colorCardId: 'morandi-violet-pink' });
  saveColorPrefs({ colorCardId: 'morandi-不存在' });
  assert.equal(loadColorPrefs().colorCardId, '', '后一次非法写入不该把文件写成脏数据');

  // 坏文件不炸
  fs.writeFileSync(file, '{不是 json', 'utf8');
  assert.deepEqual(loadColorPrefs(), { colorCardId: '' });
  initColorPrefs('');
});

test('全局配色会写进所有出图/出片的提示词（media-api 是共同出口）', () => {
  const file = tmpFile();
  initColorPrefs(file);
  assert.equal(withGlobalPalette('一个女孩站在巷口'), '一个女孩站在巷口', '没选配色就一个字都不加');

  saveColorPrefs({ colorCardId: 'vivid-red-green' });
  const out = withGlobalPalette('一个女孩站在巷口');
  assert.match(out, /^一个女孩站在巷口\n配色：/);
  assert.match(out, /#FF3730/);
  assert.match(out, /不要灰蒙蒙/, '两套卡的约束不一样，高饱和这套不许画成灰蒙蒙');

  saveColorPrefs({ colorCardId: 'morandi-violet-pink' });
  assert.match(withGlobalPalette('画面'), /不要荧光色与高饱和撞色/, '高级灰那套的约束也要带上');
  assert.equal(withGlobalPalette(''), '', '空提示词不动');
  initColorPrefs('');
});

test('故事层已经写过配色的提示词，媒体层不许追加第二次', () => {
  const file = tmpFile();
  initColorPrefs(file);
  saveColorPrefs({ colorCardId: 'vivid-red-green' });
  const already = `## 镜头规格\n全景。\n\n${colorCardPromptBlock('vivid-red-green')}`;
  assert.equal(withGlobalPalette(already), already, '同一套色写两遍只会稀释画面描述');
  // 故事层用的是**另一套**色时同理：那说明用户就是要那一套，别再补全局的
  const other = colorCardPromptBlock('morandi-blue-sand');
  assert.equal(withGlobalPalette(other), other);
  initColorPrefs('');
});

// 出口「接没接上」只能看代码：函数写好了但没人调用，等于没这个功能
test('出图/出片的出口必须真的调用它（不是只有函数没人用）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'engine', 'media-api.mjs'), 'utf8');
  const gen = src.split('export async function generateImage')[1]?.slice(0, 300) || '';
  assert.match(gen, /withGlobalPalette\(prompt\)/, 'generateImage 出口要先补配色');
  const video = src.split('export async function startVideoJob')[1]?.slice(0, 300) || '';
  assert.match(video, /withGlobalPalette\(prompt\)/, 'startVideoJob 出口也要补配色');

  // 前端：主题页要有全局选择器（写 /api/color-prefs），制作台要有「跟随全局」
  const themes = fs.readFileSync(path.join(process.cwd(), 'frontend', 'src', 'pages', 'Themes.tsx'), 'utf8');
  assert.match(themes, /ColorApi\.save\(/, '主题页要能把全局配色存到服务端');
  assert.match(themes, /创作配色卡/, '主题页要有全局创作配色的入口');
  const settings = fs.readFileSync(path.join(process.cwd(), 'frontend', 'src', 'components', 'story', 'StorySettings.tsx'), 'utf8');
  assert.match(settings, /跟随全局/, '制作台要能选择"跟随全局"');
  const api = fs.readFileSync(path.join(process.cwd(), 'frontend', 'src', 'api.ts'), 'utf8');
  assert.match(api, /\/api\/color-prefs/, '前端要有 color-prefs 接口');
});
