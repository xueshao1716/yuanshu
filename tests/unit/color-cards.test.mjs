// 配色卡（engine/color-cards.mjs）——主题页与创作流共用同一份数据，这里锁住三件事：
//   ① 9 组色值与抄录一致（改错一位数字没人看得出来，测试是唯一守门人）
//   ② 认不出来就返回 null，绝不替用户默认一套配色
//   ③ 交给模型/上游的文字里必须带上两组色值和"别画成什么样"的约束
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_CARDS, resolveColorCard, colorCardGradient, colorCardTone,
  colorCardPromptBlock, colorCardStoryboardNote,
} from '../../engine/color-cards.mjs';
import { MORANDI_CARDS } from '../../frontend/src/theme/colorcards.mjs';

const VERIFIED = [
  ['morandi-blue-sand', '蓝沙米', '#5D9AB4', '#F5D7C4'],
  ['morandi-deep-teal', '深蓝加青', '#324263', '#B0E4ED'],
  ['morandi-gray-cream', '灰得很高级', '#FCE5D7', '#728B9A'],
  ['morandi-mist-blue', '雾蓝粉', '#5B83B8', '#FFD4EA'],
  ['morandi-violet-pink', '蓝紫粉', '#6453A1', '#FDDCE4'],
  ['morandi-lilac-milk', '紫灰米', '#72749A', '#FFF5DF'],
  ['morandi-rose-blue', '玫瑰雾蓝', '#D693A1', '#E2F5FF'],
  ['morandi-pink-rice', '粉红加米', '#E16668', '#FFF4DD'],
  ['morandi-taupe-cream', '灰褐米', '#BA8D8E', '#FAF2D9'],
];

test('配色卡：9 组齐全，色值与抄录逐字一致', () => {
  assert.equal(COLOR_CARDS.length, 9);
  assert.equal(new Set(COLOR_CARDS.map(c => c.id)).size, 9, 'id 不能重复');
  for (const [id, name, from, to] of VERIFIED) {
    const card = COLOR_CARDS.find(c => c.id === id);
    assert.ok(card, `缺少配色卡 ${id}`);
    assert.equal(card.name, name);
    assert.equal(card.from, from, `${id} 起始色抄错`);
    assert.equal(card.to, to, `${id} 结束色抄错`);
    for (const key of ['from', 'to', 'top', 'bottom']) assert.match(card[key], /^#[0-9A-F]{6}$/i, `${id}.${key}`);
    assert.ok(String(card.tone).includes(card.top) && String(card.tone).includes(card.bottom), `${id} 的色调描述要带上两组色值`);
  }
});

// 主题页不自己再存一份色值：它转出的必须是同一批对象（否则一边改了另一边照旧）
test('主题页的配色卡就是引擎那一份，不是抄的副本', () => {
  assert.equal(MORANDI_CARDS, COLOR_CARDS);
});

test('配色卡：认 id、认中文名、认别名；认不出来返回 null（绝不默认一套）', () => {
  assert.equal(resolveColorCard('morandi-violet-pink')?.name, '蓝紫粉');
  assert.equal(resolveColorCard('蓝紫粉')?.id, 'morandi-violet-pink');
  assert.equal(resolveColorCard('就用蓝紫粉这套')?.id, 'morandi-violet-pink');
  assert.equal(resolveColorCard('粉红加米')?.id, 'morandi-pink-rice');
  assert.equal(resolveColorCard({ id: 'morandi-taupe-cream' })?.name, '灰褐米');
  assert.equal(resolveColorCard(''), null);
  assert.equal(resolveColorCard('随便来点高级的'), null, '认不出来就是没有，不许硬塞');
  assert.equal(resolveColorCard(null), null);
});

test('配色卡：渐变是竖向的，交给 wallpaperCssImage 是合法背景', () => {
  for (const card of COLOR_CARDS) {
    const g = colorCardGradient(card);
    assert.equal(g, `linear-gradient(180deg, ${card.top} 0%, ${card.bottom} 100%)`);
  }
  assert.equal(colorCardGradient(null), '');
  // 第 3 张的标签顺序与渐变方向相反（图上就是灰在上、米在下），这里把例外锁住
  const reversed = resolveColorCard('morandi-gray-cream');
  assert.equal(reversed.top, reversed.to);
  assert.equal(reversed.bottom, reversed.from);
});

test('配色卡：进提示词的文字带色值、带"别画成什么样"的约束', () => {
  const block = colorCardPromptBlock('蓝紫粉');
  assert.match(block, /## 配色方案（莫兰迪高级灰 · 蓝紫粉）/);
  assert.match(block, /#6453A1/);
  assert.match(block, /#FDDCE4/);
  assert.match(block, /竖向渐变/);
  assert.match(block, /不要荧光色与高饱和撞色/);
  assert.equal(colorCardPromptBlock(''), '', '没选配色就不占位置');

  const note = colorCardStoryboardNote('morandi-pink-rice');
  assert.match(note, /【本片配色】/);
  assert.match(note, /#E16668/);
  assert.match(note, /shot\.tone/, '分镜师要知道往哪个字段写');
  assert.equal(colorCardStoryboardNote(''), '');

  assert.match(colorCardTone('灰褐米'), /#BA8D8E/);
  assert.equal(colorCardTone(''), '');
});
