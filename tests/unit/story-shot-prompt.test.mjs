// 镜头提示词编译器的契约。
//
// 这个东西是从**别人的真实产物**里学回来的（2026-09-15）：同一句话创意交给同一个视频模型，
// 人家的出片像电影、我们的像"AI 图动了一下"。差别不在模型，在发过去的那段话里有没有
// 景别/机位/光线/色调/质感/运镜/**落幅**/**承接**——以及有没有把角色写成可解析的 @资产引用。
// 所以这里锁的是"编译出来的东西必须真的带上这八样、顺序对、且不许凭空编"。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STYLE_LIBRARY, GLOBAL_CONSTRAINTS, resolveStyle, inferShotFromProse, shotFieldsFromBeat,
  assetRefsForShot, splitRefs, compileShotPrompt, describeShotCompile,
} from '../../engine/story-shot-prompt.mjs';
import { cleanShotFields, cleanScenes } from '../../engine/story-assist.mjs';

test('风格库：code / 中文名 / 别名都认，认不出来返回 null（绝不硬塞默认风格）', () => {
  assert.equal(resolveStyle('suspense_movie').name, '悬疑电影风格');
  assert.equal(resolveStyle('90年代写实电影风格').code, 'realistic_90s_film');
  assert.equal(resolveStyle('我想要港风那种').code, 'realistic_hk_film');
  assert.equal(resolveStyle('这个风格库里没有'), null);
  assert.equal(resolveStyle(''), null);
  assert.equal(resolveStyle(null), null);
  // 每条风格必须有"落得下去"的四件事，不能只有形容词
  for (const [code, s] of Object.entries(STYLE_LIBRARY)) {
    assert.ok(s.name && s.look, `${code} 缺 name/look`);
    assert.ok(s.light || s.tone, `${code} 连光线和色调都没有，等于只有名字`);
  }
});

test('编译顺序：景别机位在最前，光线/色调/质感随后，然后画面、运镜、落幅、承接', () => {
  const text = compileShotPrompt({
    style: 'realistic_90s_film',
    shot: {
      size: '全景', angle: '俯拍斜角', move: '缓缓推近',
      light: '窗外折射的柔和自然光', tone: '温暖复古、略带怀旧',
      content: '林小夏独自蜷缩在座位上，低头整理课本',
      ending: '落幅定格在她落寞的侧脸', carry: '她站在墙角整理课本',
    },
    refs: [{ name: '林小夏', variant: '基础形象', ref: '@林小夏-基础形象', hasRef: true, role: 'character' }],
    kind: 'video', durationSec: 4, negative: '多余的手指',
  });
  const at = s => text.indexOf(s);
  assert.ok(text.startsWith('全景，俯拍斜角机位。'), `景别+机位必须打头：${text.slice(0, 40)}`);
  assert.ok(at('画面采用') < at('林小夏独自蜷缩'), '光线要写在画面内容之前');
  assert.ok(at('具有') < at('林小夏独自蜷缩'), '质感要写在画面内容之前');
  assert.ok(at('林小夏独自蜷缩') < at('镜头缓缓推近'), '运镜写在画面之后');
  assert.ok(at('镜头缓缓推近') < at('落幅定格'), '落幅在运镜之后');
  assert.ok(at('落幅定格') < at('承接上一镜'), '承接在最后');
  assert.match(text, /【时长】4s/);
  assert.doesNotMatch(text, /【台词】/, '没有台词就不该出现台词行');
  assert.match(text, /【必须避免】多余的手指/);
});

test('台词只给视频；全局约束按类型区分（视频怕字幕静音，图片怕文字）', () => {
  const base = { shot: { size: '近景', content: '她抬起头', dialogue: '林晚：你为什么要买它？' }, refs: [] };
  const v = compileShotPrompt({ ...base, kind: 'video' });
  assert.match(v, /【台词】林晚：你为什么要买它？/);
  assert.match(v, /【全局约束】/);
  assert.match(v, new RegExp(GLOBAL_CONSTRAINTS.video[0]));
  assert.match(v, /禁止静音段/);
  const i = compileShotPrompt({ ...base, kind: 'image' });
  assert.doesNotMatch(i, /【台词】/, '图片不出台词');
  assert.match(i, new RegExp(GLOBAL_CONSTRAINTS.image[0]));
  assert.doesNotMatch(i, /禁止静音段/, '图片不谈静音段');
});

test('老项目也要受益：从散文里认出景别/机位/运镜/落幅', () => {
  const prose = '全景，俯拍斜角机位。画面采用教室内窗外折射的柔和自然光。林小夏独自蜷缩在座位上，低头整理着桌上的课本。镜头缓缓推近，落幅定格在她落寞无助的侧脸。';
  const f = inferShotFromProse(prose);
  assert.equal(f.size, '全景');
  assert.equal(f.angle, '俯拍斜角');
  assert.equal(f.move, '镜头缓缓推近');
  assert.match(f.ending, /^落幅定格在她落寞无助的侧脸/);
  assert.match(f.light, /自然光/);
  // beat 走一遍：没有 shot 字段也能编出带景别与落幅的提示词
  const shot = shotFieldsFromBeat({ kind: 'video', prompt: prose });
  const text = compileShotPrompt({ shot, kind: 'video' });
  assert.match(text, /^全景，俯拍斜角机位。/);
  assert.match(text, /落幅定格/);
});

test('内容开头自带的景别前缀要削掉（真机验收：编出来是「特写。镜头特写：林默趴在…」）', () => {
  const beat = { kind: 'video', prompt: '镜头特写：林默趴在发霉的床垫上，嘴角有一滴口水。' };
  const f = shotFieldsFromBeat(beat);
  assert.equal(f.size, '特写', '景别要从"镜头特写："里认出来');
  assert.equal(f.content, '林默趴在发霉的床垫上，嘴角有一滴口水。', '前缀不能留，否则同一个词出现两遍');
  const text = compileShotPrompt({ shot: f, kind: 'video' });
  assert.ok(text.startsWith('特写。林默趴在'), `不该出现"特写。镜头特写"：${text.slice(0, 30)}`);
  // 削完啥都不剩就还原——宁可重复，也不能把内容吃没
  const only = shotFieldsFromBeat({ prompt: '特写。' });
  assert.equal(only.content, '特写。');
  // 没写景别的老分镜不受影响
  const plain = shotFieldsFromBeat({ prompt: '林默趴在床垫上。' });
  assert.equal(plain.content, '林默趴在床垫上。');
  assert.equal(plain.size, '');
});

test('显式 shot 字段优先于散文推断，且不许编造没写的字段', () => {  const f = shotFieldsFromBeat({ prompt: '全景。她在走路。', shot: { size: '特写', move: '跟拍' } });
  assert.equal(f.size, '特写', '显式字段优先');
  assert.equal(f.move, '跟拍');
  assert.equal(f.angle, '', '没写就不许编');
  assert.equal(f.ending, '');
  const text = compileShotPrompt({ shot: f, kind: 'image' });
  assert.match(text, /^特写。/);
  assert.doesNotMatch(text, /机位/);
  assert.doesNotMatch(text, /落幅/);
});

test('@资产引用：只挂名字真的出现在这一段里的，带形象变体，并标明有没有参考图', () => {
  const bible = {
    characters: [{ name: '林晚', refImage: 'a.png' }, { name: '周远', anchor: 'b.png' }, { name: '没出场的角色' }],
    locations: [{ name: '零点便利店', refImage: 'c.png' }],
    props: [{ name: '音乐盒' }],
  };
  const beat = { prompt: '林晚在零点便利店里擦拭柜台，柜台下藏着音乐盒。' };
  const refs = assetRefsForShot({ bible, scene: { title: '便利店夜班' }, text: beat.prompt });
  const names = refs.map(r => r.ref);
  assert.deepEqual(names, ['@林晚', '@零点便利店', '@音乐盒'], '没出场的角色不该被挂上');
  assert.equal(refs.find(r => r.name === '林晚').hasRef, true);
  assert.equal(refs.find(r => r.name === '音乐盒').hasRef, false, '没图的资产要如实标出来');
  // 场景引用要能识别出来（决定 @场景 放在句首）
  const withRoles = splitRefs(refs, '零点便利店');
  assert.equal(withRoles.find(r => r.name === '零点便利店').role, 'scene');
  assert.equal(withRoles.find(r => r.name === '林晚').role, 'character');
  // 带形象变体：这一段提到哪张形象就用哪张（looks 是对象数组，不能当字符串拼）
  const withVariant = assetRefsForShot({
    bible: { characters: [{ name: '林默', looks: [{ id: 'l1', name: '基础形象', refImage: 'a.png' }, { id: 'l2', name: '战斗装束', refImage: 'b.png' }] }] },
    text: '林默换上战斗装束冲进房间',
  });
  assert.equal(withVariant[0].ref, '@林默-战斗装束', '提到哪张形象就挂哪张');
  assert.equal(withVariant[0].hasRef, true);
  // 没提形象 → 只写名字，不硬塞一个变体
  const noLook = assetRefsForShot({
    bible: { characters: [{ name: '林默', looks: [{ id: 'l1', name: '基础形象', refImage: 'a.png' }] }] },
    text: '林默站在门口',
  });
  assert.equal(noLook[0].ref, '@林默');
  assert.equal(noLook[0].hasRef, true, '有形象图就算挂了参考图');
  // 从没出现过 "[object Object]"——looks 被当字符串拼过就会长这样
  assert.ok(!JSON.stringify(withVariant).includes('object Object'));
});

test('分镜 JSON 的 shot/seconds 必须被解析器留下（否则编译器无米下锅）', () => {
  const raw = JSON.stringify({
    bible: { characters: [{ name: '林晚' }] },
    scenes: [{
      title: '便利店夜班', summary: '发现异常',
      beats: [{
        kind: 'video', prompt: '林晚擦拭柜台', dialogue: '林晚：这货架不对。',
        shot: { size: '中景', angle: '平视', move: '缓缓推近', ending: '落幅停在她的手', carry: '上一镜她关上冰柜门', 乱写: '要被丢掉' },
        seconds: 5,
      }],
    }],
  });
  const scenes = cleanScenes(JSON.parse(raw).scenes);
  const beat = scenes[0].beats[0];
  assert.equal(beat.shot.size, '中景');
  assert.equal(beat.shot.ending, '落幅停在她的手');
  assert.equal(beat.shot.乱写, undefined, '白名单外的字段要丢掉');
  assert.equal(beat.params.seconds, 5, '时长要落到 params.seconds（预算与编译器都读它）');
  // 只认白名单，且长度设上限
  assert.deepEqual(cleanShotFields({ size: 'x'.repeat(500) }).size.length, 120);
  assert.deepEqual(cleanShotFields(null), {});
});

test('describeShotCompile 给人看的说明：补了什么一眼可见', () => {
  const bits = describeShotCompile({
    style: 'suspense_movie',
    shot: { size: '中景', ending: '落幅停在门缝' },
    refs: [{ ref: '@林晚' }],
  });
  assert.ok(bits.some(b => /风格：悬疑电影风格/.test(b)));
  assert.ok(bits.some(b => /景别：中景/.test(b)));
  assert.ok(bits.some(b => /落幅/.test(b)));
  assert.ok(bits.some(b => /资产引用 1 个/.test(b)));
});

// ── 配色卡（2026-09-16）──────────────────────────────────────────────────
// 配色卡落在③色调槽：同一部戏的每一镜因此同色，不会这一镜暖那一镜冷。
test('配色卡：没写 tone 的镜头用配色卡的色调，段落自己写了 tone 就听段落的', () => {
  const card = 'morandi-violet-pink';
  const auto = compileShotPrompt({ shot: { size: '近景', content: '她抬头' }, kind: 'image', colorCard: card });
  assert.match(auto, /呈现蓝紫 #6453A1 过渡到浅粉 #FDDCE4/);
  assert.match(auto, /竖向渐变、上深下浅/);

  // 段落显式写了色调 = 这一镜要破格，破格优先于整片配色
  const override = compileShotPrompt({ shot: { size: '近景', content: '她抬头', tone: '冷绿' }, kind: 'image', colorCard: card });
  assert.match(override, /呈现冷绿的色调/);
  assert.doesNotMatch(override, /#6453A1/);

  // 没选配色卡时不许凭空加色调
  const none = compileShotPrompt({ shot: { size: '近景', content: '她抬头' }, kind: 'image' });
  assert.doesNotMatch(none, /呈现/);
});

test('配色卡：说明里要写清这次用的是哪一套', () => {
  const bits = describeShotCompile({ shot: { size: '中景' }, colorCard: 'morandi-pink-rice' });
  assert.ok(bits.some(b => /配色：粉红加米（#E16668 → #FFF4DD）/.test(b)), bits.join(' / '));
});
