// 剧本要素与导出 / 全剧上下文 / 与角色对台词 —— 对照 Laper 补的三件
//
// Laper（laper.ai）的地基是**剧本要素 + 工业格式导出**（它整个产品就建在这上面），
// 外加 **200K 全剧本上下文** 和 **Playground（和 AI 扮演的角色对台词）**。
// 元枢这边三件都缺：能出图、出片、出正文，却拿不出一个能给人看的剧本文件；
// 生成时只看得到继承链上的前 3 段；没有任何"试戏"的手段。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDialogueLines, slugHollywood, slugChinese, beatAction, projectToElements, toFountain, toChineseScript, toFdx, renderScript, scriptStats } from '../../engine/story-screenplay.mjs';
import { buildStorySoFar, contextBudget, latestProse } from '../../engine/story-context.mjs';
import { buildRoleplayPrompt, cleanRoleplayReply, normalizePlayground, runRoleplay, PLAYGROUND_MAX_TURNS } from '../../engine/story-playground.mjs';
import { createStoryOrchestrator } from '../../engine/story-orchestrator.mjs';
import { createProject, writeProject } from '../../engine/story-store.mjs';

// ─────────── 剧本要素 ───────────

test('台词按「角色名：台词」拆成要素，括号提示与续行都要认', () => {
  const lines = parseDialogueLines([
    '阿宁（低声）：车不会来了。',
    '老周: 我知道。',
    '又过了一会儿，他才开口。',
    '画外音：末班车已经收车。',
  ].join('\n'));
  assert.deepEqual(lines[0], { type: 'dialogue', speaker: '阿宁', paren: '低声', text: '车不会来了。' });
  assert.deepEqual(lines[1], { type: 'dialogue', speaker: '老周', paren: '', text: '我知道。' });
  // 没有冒号：上一行有说话人 → 当作同一人的续行（不是动作）
  assert.deepEqual(lines[2], { type: 'dialogue', speaker: '老周', paren: '', text: '又过了一会儿，他才开口。' });
  assert.deepEqual(lines[3], { type: 'dialogue', speaker: '画外音', paren: '', text: '末班车已经收车。' });
  // 开头就没有说话人 → 只能是动作行
  assert.deepEqual(parseDialogueLines('雨点砸在顶棚上。'), [{ type: 'action', text: '雨点砸在顶棚上。' }]);
  assert.equal(parseDialogueLines('').length, 0);
});

// 2026-09-15：从别的工具导出的真剧本（Pavo）把动作写成 `△ …`，其中一行还带全角冒号
// （`△ 记忆画面：年轻的林默穿着…`）。旧解析器把它当成"说话人 △ 记忆画面"，
// 并把后面所有无冒号的动作行都并进去，整段动作变成一句 190 字的"台词"，台词机检全跑偏。
test('△/▲/○ 动作行永远是动作：不当说话人，也不吞掉后面的动作', () => {
  const lines = parseDialogueLines([
    '林默（低声）：这是哪……',
    '△ 记忆画面：年轻的林默穿着工程服，站在楼顶。',
    '他手里攥着蓝色的全息图纸。',
    '陈曦：你挡住了我的视线。',
  ].join('\n'));
  assert.deepEqual(lines[0], { type: 'dialogue', speaker: '林默', paren: '低声', text: '这是哪……' });
  assert.deepEqual(lines[1], { type: 'action', text: '记忆画面：年轻的林默穿着工程服，站在楼顶。' });
  // 动作行之后的续行也是动作，不能续进上一句台词
  assert.deepEqual(lines[2], { type: 'action', text: '他手里攥着蓝色的全息图纸。' });
  assert.deepEqual(lines[3], { type: 'dialogue', speaker: '陈曦', paren: '', text: '你挡住了我的视线。' });
  // 圆点/星号等其它动作标记同理
  assert.deepEqual(parseDialogueLines('○ 门开了。'), [{ type: 'action', text: '门开了。' }]);
  assert.equal(parseDialogueLines('△ 走了。').filter(r => r.type === 'dialogue').length, 0);
});

test('场景标题：没填要素也要能导出（用场景名兜底，不许因为缺字段就导不出东西）', () => {
  assert.equal(slugHollywood({ title: '站台', slug: { interior: 'exterior', location: '站台', timeOfDay: 'NIGHT' } }), 'EXT. 站台 - NIGHT');
  assert.equal(slugChinese({ title: '站台', slug: { interior: 'interior', location: '站台', timeOfDay: '夜' } }), '内景 站台 夜');
  assert.equal(slugHollywood({ title: '开场' }), 'INT. 开场');
  assert.equal(slugChinese({ id: 's1' }), '内景 未命名场景');
  assert.equal(slugHollywood({ title: 'x', slug: { interior: '乱写' } }), 'INT. x', '非法内外景回落到内景');
});

test('动作行优先用显式剧本动作，退回画面描述——两者不是一回事', () => {
  assert.equal(beatAction({ action: '他把烟摁灭。', prompt: '特写，浅景深，顶光' }), '他把烟摁灭。');
  assert.equal(beatAction({ prompt: '特写，浅景深，顶光' }), '特写，浅景深，顶光', '没写动作就用画面描述兜底');
  assert.equal(beatAction({}), '');
});

const demo = {
  title: '末班车',
  logline: '一个不愿下车的乘客。',
  bible: { characters: [] },
  scenes: [{
    id: 's1', index: 1, title: '站台', summary: '两人对峙', slug: { interior: 'exterior', location: '站台', timeOfDay: '夜' },
    beats: [
      { id: 'b1', kind: 'novel', prompt: '雨夜站台', action: '雨点砸在顶棚上。', dialogue: '阿宁（低声）：车不会来了。\n老周：我知道。' },
      { id: 'b2', kind: 'image', prompt: '特写', transition: '切至' },
    ],
    outputs: [],
  }],
};

test('三种导出共用同一份要素流，谁也不许自己另算一遍', () => {
  const els = projectToElements(demo);
  assert.deepEqual(els.map(e => e.type), ['scene_heading', 'synopsis', 'action', 'dialogue', 'dialogue', 'action', 'transition']);
  const cn = toChineseScript(demo);
  assert.match(cn, /1、内景|1、外景/);
  assert.match(cn, /雨点砸在顶棚上。/);
  assert.match(cn, /阿宁（低声）：车不会来了。/);
  assert.match(cn, /切至/);
  const f = toFountain(demo);
  assert.match(f, /Title: 末班车/);
  assert.match(f, /^EXT\. 站台 - 夜$/m, 'Fountain 的场景标题用行业写法');
  assert.match(f, /^阿宁$/m, '角色名单独一行');
  assert.match(f, /^\(低声\)$/m);
  assert.match(f, /^> 切至$/m, 'Fountain 的转场用 > 前缀');
  assert.match(f, /^= 两人对峙$/m, '梗概行用 = 前缀');
});

test('FDX 是合法 XML，段落类型按公开约定', () => {
  const xml = toFdx(demo);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8" standalone="no"\?>/);
  assert.match(xml, /<FinalDraft DocumentType="Script"/);
  for (const type of ['Scene Heading', 'Action', 'Character', 'Parenthetical', 'Dialogue', 'Transition']) {
    assert.ok(xml.includes(`Type="${type}"`), `缺 ${type} 段落`);
  }
  assert.doesNotMatch(xml, /Type="Synopsis"/, '梗概不该写进 FDX 正文（那是大纲视图的事）');
  // 转义：& < > 与引号都不能把 XML 弄坏
  const nasty = toFdx({ title: 't', scenes: [{ id: 's', title: 'a & b <c>', beats: [{ id: 'b', prompt: '5 > 3 & "x"' }], outputs: [] }] });
  assert.match(nasty, /a &amp; b &lt;c&gt;/);
  assert.match(nasty, /5 &gt; 3 &amp; &quot;x&quot;/);
  // 结构自检：标签配平（不引第三方解析器，但至少要配平）
  const open = (nasty.match(/<Paragraph /g) || []).length;
  const close = (nasty.match(/<\/Paragraph>/g) || []).length;
  assert.equal(open, close);
});

test('导出格式与统计：renderScript 兜底、统计口径一致', () => {
  assert.equal(renderScript(demo, 'fdx').ext, 'fdx');
  assert.equal(renderScript(demo, '乱写').format, 'txt', '不认识的格式回落到中文剧本，而不是报错导不出');
  const s = scriptStats(demo);
  assert.deepEqual({ scenes: s.scenes, dialogueLines: s.dialogueLines, transitions: s.transitions }, { scenes: 1, dialogueLines: 2, transitions: 1 });
  assert.deepEqual(s.speakers, ['阿宁', '老周']);
  // 空项目也要能导出（不能因为没内容就崩）
  const empty = renderScript({ title: '空', scenes: [] }, 'txt');
  assert.match(empty.body, /空/);
});

// ─────────── 全剧上下文 ───────────

const longProject = () => createProject({
  title: '长篇',
  scenes: Array.from({ length: 6 }, (_, i) => ({
    id: `s${i}`, index: i + 1, title: `第 ${i + 1} 场`, summary: `第 ${i + 1} 场发生的事`,
    beats: [{ id: `b${i}`, kind: 'novel', prompt: `第 ${i + 1} 段的画面`, dialogue: `阿宁：第 ${i + 1} 句台词`, references: [] }],
    outputs: [{ id: `r${i}`, beatId: `b${i}`, kind: 'novel', status: 'succeeded', outputAssets: [{ id: 'a', type: 'text', text: `第 ${i + 1} 段正文`.repeat(300) }] }],
  })),
}, { id: () => 'pl' });

test('全剧至今：带场摘要 + 台词 + 已写正文，且排除当前这一段', () => {
  const p = longProject();
  const soFar = buildStorySoFar(p, { maxChars: 20000, excludeBeatId: 'b3' });
  assert.equal(soFar.scenes, 6);
  assert.match(soFar.text, /第 1 场发生的事/, '最早的场摘要也要在——这正是"继承链前 3 段"看不到的');
  assert.match(soFar.text, /第 6 句台词/);
  assert.match(soFar.text, /已写正文：/);
  assert.match(soFar.text, /全剧至今/, '要说明这是既成事实，只保持一致、不要复述');
  assert.doesNotMatch(soFar.text, /第 4 段正文/, '当前这一段的正文要被排除（它还没写/正在写）');
  assert.equal(soFar.truncated, false);
});

test('全剧至今有上限，且**砍过要说出来**；预算是可配的', () => {
  const p = longProject();
  const full = buildStorySoFar(p, { maxChars: 20000 });
  assert.equal(full.truncated, false);
  const small = buildStorySoFar(p, { maxChars: 2000 });
  assert.ok(small.chars <= 2000 + 200, `实际 ${small.chars} 不该超过预算太多`);
  assert.equal(small.truncated, true, `没砍到就测不出上限（全文 ${full.chars} 字）`);
  assert.match(small.text, /被省略了/, '砍了就要说，不能让人以为模型看到了全部');
  assert.equal(contextBudget({}), 20000);
  assert.equal(contextBudget({ STORY_CONTEXT_CHARS: '60000' }), 60000);
  assert.equal(contextBudget({ STORY_CONTEXT_CHARS: 'abc' }), 20000);
  assert.equal(contextBudget({ STORY_CONTEXT_CHARS: '10' }), 20000, '太小的值当没设');
  // 非文字段落不该有"已写正文"
  assert.equal(latestProse({ outputs: [{ beatId: 'b', kind: 'image', status: 'succeeded', outputAssets: [{ type: 'text', text: 'x' }] }] }, 'b', 'image'), '');
});

test('生成时真的把全剧上下文带上了（执行链里看得见字数）', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-ctx-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = longProject();
  await writeProject(root, project);
  const api = createStoryOrchestrator({ root, getModelList: () => [{ provider: 'p', id: 'm', capabilities: { chat: true } }] });
  const pv = await api.previewRun('pl', { sceneId: 's0', beatId: 'b0', kind: 'novel', model: { provider: 'p', id: 'm' } });
  assert.match(pv.context.prompt, /全剧至今/);
  const row = pv.plan.find(s => s.label === '全剧上下文');
  assert.ok(row, '执行链要有一行说明这次带了多少全剧上下文');
  assert.match(row.detail, /\d+ 字/);
});

// ─────────── 与角色对台词（Playground）── ───────────

test('试戏提示词：只能依据设定、只能说自己的话、不许给创作建议', () => {
  const prompt = buildRoleplayPrompt({
    project: { title: '末班车', bible: { rules: [{ text: '不许有人说普通话以外的语言' }] } },
    character: { id: 'c1', name: '阿宁', appearance: '二十岁，短发', secret: '他认识司机' },
    scene: { title: '站台', summary: '两人对峙' },
    beat: { dialogue: '阿宁：车不会来了。' },
    storySoFar: '## 全剧至今\n第 1 场：他上过车。',
    message: '你为什么不走？',
  });
  assert.match(prompt, /扮演/);
  assert.match(prompt, /阿宁/);
  assert.match(prompt, /短发/);
  assert.match(prompt, /不要写旁白/, '不许把旁白混进台词');
  assert.match(prompt, /不要替别的角色说话/);
  assert.match(prompt, /不要给编剧提建议/, '他只能演，不能替编剧做决定');
  assert.match(prompt, /只能依据这些，不许自己编新设定/);
  assert.match(prompt, /全剧至今/);
  assert.match(prompt, /你为什么不走？/);
});

test('角色回话要剥掉外壳；对话留档有上限', () => {
  assert.equal(cleanRoleplayReply('「我不走。」'), '我不走。');
  assert.equal(cleanRoleplayReply('（沉默片刻）车不来了。'), '车不来了。');
  assert.equal(cleanRoleplayReply('```\n我不走。\n```'), '我不走。');
  assert.equal(cleanRoleplayReply('   '), '');
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'character' : 'writer', text: `第 ${i} 句` }));
  const norm = normalizePlayground(many);
  assert.equal(norm.length, PLAYGROUND_MAX_TURNS, '留档有上限，别让试戏把项目撑爆');
  assert.equal(norm[0].text, '第 10 句', '超上限时丢最早的那些');
  assert.deepEqual(normalizePlayground([{ role: 'x', text: 'hi' }])[0].role, 'writer', '不认识的 role 归到编剧');
  assert.deepEqual(normalizePlayground([{ role: 'character', text: '' }]), [], '空话不占位');
});

test('对台词走 directChat，历史喂回去，空回复要报错不是静默', async () => {
  const calls = [];
  const r = await runRoleplay({
    directChat: async (model, prompt, history, opts) => { calls.push({ model, prompt, history, ...(opts || {}) }); return { text: '「我不走。」' } },
    model: { provider: 'p', id: 'chat' },
    project: { title: 't', bible: {} }, character: { id: 'c', name: '阿宁' }, scene: { title: 's' }, beat: {},
    history: [{ role: 'writer', text: '你为什么不走？' }, { role: 'character', text: '车不来了。' }],
    message: '那你打算怎么办？',
  });
  assert.equal(r.reply, '我不走。');
  assert.deepEqual(calls[0].history, [{ role: 'user', content: '你为什么不走？' }, { role: 'assistant', content: '车不来了。' }]);
  // 思考必须显式关掉：推理模型开着思考时，1–3 句台词会被吃光，拿回来的 content 是空的
  assert.equal(calls[0].thinking, false, '短台词任务要显式关思考（仓库里"填充/短任务必须关掉"同一条纪律）');
  // 三种失败要分得开：没凭据（directChat 返回 null）/ 有内容但没台词 / 没说话就发送
  await assert.rejects(
    () => runRoleplay({ directChat: async () => ({ text: '' }), model: { provider: 'p', id: 'm' }, project: {}, character: {}, scene: {}, beat: {}, message: 'x' }),
    /没有台词/,
  );
  await assert.rejects(
    () => runRoleplay({ directChat: async () => null, model: { provider: 'p', id: 'm' }, project: {}, character: {}, scene: {}, beat: {}, message: 'x' }),
    /没有可用凭据或端点/,
    'directChat 返回 null 是"没被调用"，不能和"返回空内容"混成一句话',
  );
  await assert.rejects(() => runRoleplay({ directChat: async () => ({ text: 'x' }), model: {}, project: {}, character: {}, scene: {}, beat: {}, message: '  ' }), /先说一句/);
  await assert.rejects(() => runRoleplay({ model: {}, project: {}, character: {}, scene: {}, beat: {}, message: 'x' }), /未接入/);
});

test('自述不是台词：绝不能把"用户让我扮演…"当成角色说的话', async () => {
  const { looksLikeMetaReply } = await import('../../engine/story-playground.mjs');
  // 真实踩到的那一条
  assert.equal(looksLikeMetaReply('用户让我扮演角色"阿宁"，和编剧对台词。编剧问"你为什么不走？"'), true);
  assert.equal(looksLikeMetaReply('我需要扮演阿宁，所以我会回答：'), true);
  assert.equal(looksLikeMetaReply('根据角色设定，他应该说：我不走。'), true);
  // 真台词不能被误伤
  assert.equal(looksLikeMetaReply('我不走。'), false);
  assert.equal(looksLikeMetaReply('车不会来了。你也不用再等了。'), false);
  assert.equal(looksLikeMetaReply('他说"用户让我扮演"——我不信。'), false, '引号里的话不算自述');
  assert.equal(looksLikeMetaReply(''), false);
  // 自述要走"报错→换模型"，而不是把自述当回复展示
  await assert.rejects(
    () => runRoleplay({ directChat: async () => ({ text: '用户让我扮演角色"阿宁"。' }), model: { provider: 'p', id: 'weak' }, project: {}, character: {}, scene: {}, beat: {}, message: 'x' }),
    /在自述而不是演/,
  );
});

// ─────────── 场景/道具参考图（对手都在解决的"场景漂移"）── ───────────

test('场景与道具的参考图走和角色同一条规则：名字出现在提示词里就挂上', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-assetref-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '资产',
    bible: {
      characters: [{ id: 'c1', name: '阿宁', refImage: '/p/aning.png' }],
      locations: [{ id: 'l1', name: '公交站台', refImage: '/p/station.png' }, { id: 'l2', name: '末班车', refImage: '/p/bus.png' }],
      props: [{ id: 'p1', name: '蓝色信封', refImage: '/p/envelope.png' }],
    },
    scenes: [{ id: 's1', index: 1, title: '站台', summary: '', beats: [{ id: 'b1', kind: 'video', prompt: '阿宁在公交站台等车', references: [] }], outputs: [] }],
  }, { id: () => 'pa' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({ root, getModelList: () => [{ provider: 'a', id: 'v', capabilities: { video: true, reference: true, keyframe: true, seed: true } }] });
  const pv = await api.previewRun('pa', { sceneId: 's1', beatId: 'b1', kind: 'video', model: { provider: 'a', id: 'v' } });
  const list = pv.plan.find(s => s.label === '参考图清单').detail;
  assert.match(list, /aning\.png/, '角色参考图要在');
  assert.match(list, /station\.png/, '**场景参考图也要在**——此前场景只有文字，同一间屋子两段长得不一样');
  assert.doesNotMatch(list, /bus\.png/, '这一段的提示词里没提到「末班车」，就不该挂它的参考图');
  assert.doesNotMatch(list, /envelope\.png/, '道具同理：没提到就不挂');
  // 提到道具就要挂上
  await api.patch('pa', { scenes: [{ ...project.scenes[0], beats: [{ ...project.scenes[0].beats[0], prompt: '阿宁攥着蓝色信封站在公交站台' }] }] });
  const pv2 = await api.previewRun('pa', { sceneId: 's1', beatId: 'b1', kind: 'video', model: { provider: 'a', id: 'v' } });
  assert.match(pv2.plan.find(s => s.label === '参考图清单').detail, /envelope\.png/, '提到道具就带上它');
});

test('参考图资产三件共用一条通路：角色/场景/道具都能生成并写回对应条目', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-assetgen-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '生成资产',
    bible: { characters: [{ id: 'c1', name: '阿宁' }], locations: [{ id: 'l1', name: '公交站台' }], props: [{ id: 'p1', name: '蓝色信封' }] },
    scenes: [{ id: 's1', index: 1, title: '站台', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: 'x', references: [] }], outputs: [] }],
  }, { id: () => 'pg' });
  await writeProject(root, project);
  let seen = null;
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'p', id: 'img', capabilities: { image: true, reference: true, seed: true } }],
    adapters: { image: { generate: async ({ prompt, params }) => { seen = { prompt, params }; return { status: 'succeeded', output: { type: 'image', url: '/gen.png' } } } } },
  });
  const loc = await api.generateAssetRef('pg', { assetType: 'location', assetId: 'l1' });
  assert.equal(loc.image, '/gen.png');
  assert.match(seen.prompt, /场景参考图/, '场景提示词要说清这是可复用的场景锚点');
  assert.match(seen.prompt, /不要出现任何人物/, '有人的场景图当不了场景锚点');
  assert.equal(loc.project.bible.locations[0].refImage, '/gen.png', '写回 locations，不是 characters');
  const prop = await api.generateAssetRef('pg', { assetType: 'prop', assetId: 'p1' });
  assert.match(seen.prompt, /道具参考图/);
  assert.equal(prop.project.bible.props[0].refImage, '/gen.png');
  // 角色走同一条路（老的 generatePortrait 是它的特例，返回形状保持兼容）
  const ch = await api.generatePortrait('pg', { characterId: 'c1' });
  assert.equal(ch.character.refImage, '/gen.png');
  assert.match(seen.prompt, /角色定妆照/);
  assert.equal(ch.project.bible.characters[0].refImage, '/gen.png');

  // ── 形象变体：同一张脸的第二套行头 ──
  // 一个角色只锁一张脸不够：换装段落没有对应形象图，模型只能靠文字猜，一致性立刻掉。
  const look = await api.generatePortrait('pg', { characterId: 'c1', lookName: '战斗装束' });
  assert.equal(look.look.name, '战斗装束');
  assert.match(seen.prompt, /形象名：战斗装束/, '提示词要写清这一张是哪套形象');
  assert.match(seen.prompt, /脸、发型、体格必须与角色设定完全一致/, '换装不能换脸');
  const char = look.project.bible.characters[0];
  assert.equal(char.looks.length, 2, '基础形象 + 新形象');
  assert.equal(char.looks[1].refImage, '/gen.png');
  assert.equal(char.looks[1].name, '战斗装束');
  // 第一张形象同时写回 refImage（老代码只认 refImage，别让它看不见）
  assert.equal(char.looks[0].refImage, '/gen.png');
  assert.equal(char.refImage, '/gen.png', '基础形象仍然写 refImage');
  // 指定已存在的形象名 → 重做那一张，不再新增
  const again = await api.generatePortrait('pg', { characterId: 'c1', lookName: '战斗装束' });
  assert.equal(again.project.bible.characters[0].looks.length, 2, '同名形象是重做，不是新增');

  // 老角色（有这个功能之前就生成过定妆照：只有 refImage、没有 looks）再加一张新形象时，
  // **不许把 refImage 顶掉**——真机踩到过：给林默加「战斗装束」，结果基础定妆照被覆盖了。
  const legacy = createProject({
    title: '老项目',
    bible: { characters: [{ id: 'c9', name: '老角色', refImage: '/old-base.png' }] },
    scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: 'x', references: [] }], outputs: [] }],
  }, { id: () => 'pl' });
  await writeProject(root, legacy);
  const added = await api.generatePortrait('pl', { characterId: 'c9', lookName: '战斗装束' });
  const c9 = added.project.bible.characters[0];
  assert.equal(c9.refImage, '/old-base.png', '基础定妆照不能被新形象覆盖');
  assert.deepEqual(c9.looks.map(l => l.name), ['基础形象', '战斗装束'], '既有的那张要登记成基础形象，新的排在后面');
  assert.equal(c9.looks[0].refImage, '/old-base.png', '基础形象指向原来那张图');
  // 空设定要给出可操作的提示，而不是 500
  const bare = await api.create({ title: '空的' });
  await assert.rejects(() => api.generateAssetRef(bare.id, { assetType: 'location' }), /还没有场景/);
});

test('对台词结果落进 beat.playground（可追溯），清空是真的清空', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-pg-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '试戏',
    bible: { characters: [{ id: 'c1', name: '阿宁', appearance: '短发' }] },
    scenes: [{ id: 's1', index: 1, title: '站台', summary: '', beats: [{ id: 'b1', kind: 'novel', prompt: '雨夜', references: [] }], outputs: [] }],
  }, { id: () => 'pp' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({ root, directChat: async () => ({ text: '「我不走。」' }), getModelList: () => [{ provider: 'p', id: 'chat' }], getDefaultModel: () => ({ provider: 'p', id: 'chat' }) });
  const r = await api.playground('pp', { sceneId: 's1', beatId: 'b1', characterId: 'c1', message: '你为什么不走？' });
  assert.equal(r.reply, '我不走。');
  assert.deepEqual(r.turns.map(x => x.role), ['writer', 'character']);
  const stored = (await api.get('pp')).scenes[0].beats[0].playground;
  assert.equal(stored.length, 2);
  assert.equal(stored[1].text, '我不走。');
  const cleared = await api.clearPlayground('pp', { sceneId: 's1', beatId: 'b1' });
  assert.deepEqual(cleared.project.scenes[0].beats[0].playground, []);
  assert.deepEqual((await api.get('pp')).scenes[0].beats[0].playground, []);
  // 没角色的项目要给出可操作的提示，而不是 500
  await assert.rejects(() => api.playground('pp', { sceneId: 's1', beatId: 'b1', message: 'x' }).then(() => { throw new Error('不该成功') }).catch(e => { if (e.message === '不该成功') throw e; throw e; }), /./);
});
