// 配色卡（engine/color-cards.mjs）——两套 18 组，主题页与创作流共用同一份数据。
// 这里锁四件事：
//   ① 18 组色值与抄录一致（改错一位数字没人看得出来，测试是唯一守门人）
//   ② 两套的"别画成什么样"各自成立（高级灰不许荧光色；高饱和不许灰蒙蒙）
//   ③ 认不出来返回 null，绝不替用户默认一套
//   ④ 交给模型/上游的文字里必须带色值和约束
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLOR_CARDS, MORANDI_CARDS, VIVID_CARDS, CARD_FAMILIES,
  resolveColorCard, colorCardGradient, colorCardTone, colorCardRule, colorCardStyleLine,
  colorCardPromptBlock, colorCardStoryboardNote, hasColorCardMark,
  colorCardOn, colorCardPillVars,
} from '../../engine/color-cards.mjs';
import { COLOR_CARDS as FRONT_CARDS } from '../../frontend/src/theme/colorcards.mjs';
import { contrast } from '../../frontend/src/theme/generate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// 第一套：莫兰迪高级灰（id / 名 / 左标签 / 右标签）
const VERIFIED_MORANDI = [
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
// 第二套：高饱和渐变（2026-09-16 用户给的第二张色卡图）
const VERIFIED_VIVID = [
  ['vivid-rose-ice', '粉青', '#FF768D', '#E5FFFD'],
  ['vivid-blue-cream', '蓝紫奶油', '#5E6BFF', '#FFFEDA'],
  ['vivid-teal-cream', '青蓝奶油', '#1899B6', '#FFFCCD'],
  ['vivid-sky-linen', '天蓝米白', '#30A9FF', '#FFF4E3'],
  ['vivid-orange-ice', '橙青撞色', '#F5600F', '#E2FFFD'],
  ['vivid-violet-pink', '紫粉', '#5D62CC', '#FFDDDD'],
  ['vivid-green-pink', '绿粉撞色', '#18B670', '#FFD0D0'],
  ['vivid-magenta-ice', '品红冰蓝', '#B61877', '#DDFEFF'],
  ['vivid-red-green', '红绿撞色', '#FF3730', '#D2FFD2'],
];

const checkSet = (cards, verified) => {
  for (const [id, name, from, to] of verified) {
    const card = cards.find(c => c.id === id);
    assert.ok(card, `缺少配色卡 ${id}`);
    assert.equal(card.name, name);
    assert.equal(card.from, from, `${id} 起始色抄错`);
    assert.equal(card.to, to, `${id} 结束色抄错`);
    for (const key of ['from', 'to', 'top', 'bottom']) assert.match(card[key], /^#[0-9A-F]{6}$/i, `${id}.${key}`);
    assert.ok(String(card.tone).includes(card.top) && String(card.tone).includes(card.bottom), `${id} 的色调描述要带上两组色值`);
  }
};

test('两套各 9 组、合计 18 组，色值与抄录逐字一致', () => {
  assert.equal(MORANDI_CARDS.length, 9);
  assert.equal(VIVID_CARDS.length, 9);
  assert.equal(COLOR_CARDS.length, 18);
  assert.equal(new Set(COLOR_CARDS.map(c => c.id)).size, 18, 'id 不能重复');
  checkSet(MORANDI_CARDS, VERIFIED_MORANDI);
  checkSet(VIVID_CARDS, VERIFIED_VIVID);
  // 每张卡都要挂在某一套上，且两套的 id 前缀对得上（前端按 family 分组渲染）
  for (const card of COLOR_CARDS) {
    assert.ok(CARD_FAMILIES[card.family], `${card.id} 的 family 不认识`);
    assert.ok(card.id.startsWith(`${card.family}-`), `${card.id} 的 id 前缀和 family 不一致`);
  }
});

test('主题页/前端转出的就是引擎那一份，不是抄的副本', () => {
  assert.equal(FRONT_CARDS, COLOR_CARDS);
});

test('配色卡：认 id、认中文名、认别名；认不出来返回 null（绝不默认一套）', () => {
  assert.equal(resolveColorCard('morandi-violet-pink')?.name, '蓝紫粉');
  assert.equal(resolveColorCard('蓝紫粉')?.id, 'morandi-violet-pink');
  assert.equal(resolveColorCard('就用蓝紫粉这套')?.id, 'morandi-violet-pink');
  assert.equal(resolveColorCard('红配绿')?.id, 'vivid-red-green', '第二套的别名也要认');
  assert.equal(resolveColorCard('vivid-red-green')?.name, '红绿撞色');
  assert.equal(resolveColorCard({ id: 'vivid-rose-ice' })?.name, '粉青');
  assert.equal(resolveColorCard(''), null);
  assert.equal(resolveColorCard('随便来点高级的'), null, '认不出来就是没有，不许硬塞');
  assert.equal(resolveColorCard('morandi-不存在'), null);
  assert.equal(resolveColorCard(null), null);
});

test('配色卡：渐变是竖向的，交给 wallpaperCssImage 是合法背景', () => {
  for (const card of COLOR_CARDS) {
    assert.equal(colorCardGradient(card), `linear-gradient(180deg, ${card.top} 0%, ${card.bottom} 100%)`);
  }
  assert.equal(colorCardGradient(null), '');
  // 莫兰迪第 3 张的标签顺序与渐变方向相反（图上就是灰在上、米在下），这条例外得留着
  const reversed = resolveColorCard('morandi-gray-cream');
  assert.equal(reversed.top, reversed.to);
  assert.equal(reversed.bottom, reversed.from);
});

test('两套卡的约束不同：高级灰不许荧光色，高饱和不许灰蒙蒙', () => {
  assert.match(colorCardRule('蓝紫粉'), /不要荧光色与高饱和撞色/);
  assert.match(colorCardRule('红绿撞色'), /高饱和、明快、敢于撞色/);
  assert.match(colorCardRule('红绿撞色'), /不要灰蒙蒙/);
  assert.match(colorCardStyleLine('红绿撞色'), /#FF3730/);
  assert.match(colorCardStyleLine('红绿撞色'), /不要灰蒙蒙/);
  assert.equal(colorCardRule(''), '');
  assert.equal(colorCardStyleLine(''), '');
  assert.equal(colorCardTone(''), '');
  assert.match(colorCardTone('灰褐米'), /#BA8D8E/);
});

test('配色卡：进提示词的文字带色值、带"别画成什么样"的约束', () => {
  const block = colorCardPromptBlock('蓝紫粉');
  assert.match(block, /## 配色方案（莫兰迪高级灰 · 蓝紫粉）/);
  assert.match(block, /#6453A1/);
  assert.match(block, /#FDDCE4/);
  assert.match(block, /竖向渐变/);
  assert.equal(colorCardPromptBlock(''), '', '没选配色就不占位置');

  const vivid = colorCardPromptBlock('vivid-red-green');
  assert.match(vivid, /## 配色方案（高饱和渐变 · 红绿撞色）/);

  const note = colorCardStoryboardNote('morandi-pink-rice');
  assert.match(note, /【本片配色】/);
  assert.match(note, /#E16668/);
  assert.match(note, /shot\.tone/, '分镜师要知道往哪个字段写');
  assert.equal(colorCardStoryboardNote(''), '');
});

test('已经带过配色的提示词要认得出来（媒体层不许再追加一次）', () => {
  assert.equal(hasColorCardMark(colorCardPromptBlock('蓝紫粉')), true);
  assert.equal(hasColorCardMark(colorCardStoryboardNote('蓝紫粉')), true);
  assert.equal(hasColorCardMark('一个女孩站在巷口'), false);
  assert.equal(hasColorCardMark(''), false);
});

// ── 悬浮药丸（2026-09-16，用户给的 "3colors combination" 参考图）──────────
// 药丸的底就是卡的身份色，字色必须按对比度挑：写死白字的话，米白/浅青那几张直接看不清。
test('悬浮药丸：18 张卡当底时，字色都够读（不写死白字）', () => {
  for (const card of COLOR_CARDS) {
    const on = colorCardOn(card);
    assert.match(on, /^#(ffffff|000000)$/i, `${card.id} 的字色只该是白或黑`);
    const cr = contrast(on, card.top);
    assert.ok(cr >= 4.5, `${card.name}：${on} on ${card.top} = ${cr.toFixed(2)} < 4.5`);
    // 挑的必须是**更优**的那个
    const other = on.toLowerCase() === '#ffffff' ? '#000000' : '#ffffff';
    assert.ok(cr >= contrast(other, card.top), `${card.name} 挑错了字色`);
  }
  // 药丸要用的三件（底/字/投影色）都在
  const vars = colorCardPillVars('红绿撞色');
  assert.equal(vars['--float-bg'], '#FF3730');
  assert.equal(vars['--float-tint'], '#FF3730');
  assert.equal(vars['--float-tint-2'], '#D2FFD2');
  assert.deepEqual(colorCardPillVars(''), {});
});

test('悬浮药丸的样式：投影必须带自己的颜色，且有悬停抬起/按下压回', () => {
  const css = read('frontend', 'src', 'styles.css');
  assert.match(css, /\.float-pill\s*\{[^}]*--float-tint:\s*var\(--pi-accent\)/, '药丸要有投影色变量');
  assert.match(css, /\.float-pill\s*\{[^}]*box-shadow:[^}]*color-mix\(in srgb, var\(--float-tint\)/, '投影要掺自己的颜色（这是"浮起来"的关键）');
  assert.match(css, /\.float-pill:hover[^{]*\{[^}]*translateY\(-2px\)/, '悬停要抬起来');
  assert.match(css, /\.float-pill:active[^{]*\{[^}]*translateY\(1px\)/, '按下要压回去');
  assert.match(css, /\.float-pill-dot\s*\{/, '左侧要有同色小圆点');
  const themes = read('frontend', 'src', 'pages', 'Themes.tsx');
  assert.match(themes, /<FloatPill/, '主题页的配色卡要用悬浮药丸渲染');
  assert.match(themes, /fg=\{colorCardOn\(card\)\}/, '药丸字色要按对比度算，不能写死');
  const component = read('frontend', 'src', 'components', 'FloatPill.tsx');
  assert.match(component, /aria-pressed=\{active\}/, '药丸是可点的选择控件，要有 aria-pressed');
});
