// 「参考图策略」+「项目级默认配方」契约
//
// 两件事都是把配方推完整：
//  1) 参考图策略（用几张、谁优先）此前**硬编码在编排层**——画面固定"素材优先且只 1 张"、
//     视频固定"定妆照优先且 4 张"，用户在界面上既看不到也改不了，更存不进配方。
//  2) 项目级默认配方：把"这套设置"变成**项目的默认**，新段落自动套用，
//     段落自己没说的地方由它兜底——否则同一部片子 10 个段落还是要点 10 遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStoryOrchestrator } from '../../engine/story/orchestrator.mjs';
import { createProject, writeProject } from '../../engine/story/store.mjs';
import { saveRecipe } from '../../engine/story/recipes.mjs';

const IMG_CAPS = { image: true, reference: true, seed: true };
const VIDEO_CAPS = { video: true, reference: true, keyframe: true, seed: true };

async function fixture(t, { kind = 'image', caps = IMG_CAPS, characters = 2, materials = 2 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-refstrat-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mk = async (rel, byte) => {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, byte]));
    return `/api/ws/file?path=${encodeURIComponent(path.relative(root, p))}`;
  };
  const portraits = [];
  for (let i = 0; i < characters; i++) portraits.push(await mk(`生成物/图片/portrait${i}.png`, 10 + i));
  const mats = [];
  for (let i = 0; i < materials; i++) mats.push(await mk(`生成物/图片/mood${i}.png`, 20 + i));
  const project = createProject({
    title: '策略',
    bible: { characters: portraits.map((url, i) => ({ id: `c${i}`, name: ['阿宁', '老周', '小雨'][i] || `角色${i}`, refImage: url })) },
    scenes: [{
      id: 's1', index: 1, title: '探针场', summary: '',
      // 两个角色都要在段落文本里被提到，才会两张定妆照都挂上——
      // 判定基于**段落自己的文本**（不是编译后的提示词，那里面列着整个 bible）
      beats: [{ id: 'b1', kind, prompt: '阿宁和老周站在站台', references: [], inputs: mats.map((url, i) => ({ id: `m${i}`, type: 'image', url, name: `mood${i}.png` })) }],
      outputs: [],
    }],
  }, { id: () => 'pr' });
  await writeProject(root, project);
  return { root, mats, portraits };
}

const planOf = async (api, body, id = 'pr') => (await api.previewRun(id, { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, ...body })).plan;
const detail = (plan, label) => plan.find(s => s.label === label)?.detail;

test('参考图张数由策略决定：0 张就是明确不用，不是"没找到"', async t => {
  const { root } = await fixture(t);
  const api = createStoryOrchestrator({ root, getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: IMG_CAPS }] });
  const zero = await planOf(api, { reference: { images: 0, prefer: 'portrait' } });
  assert.match(detail(zero, '参考图'), /不使用/, '关掉参考图要说得清清楚楚，别让人以为"没找到定妆照"');
  assert.equal(detail(zero, '参考图清单'), '—');
  const two = await planOf(api, { reference: { images: 2, prefer: 'portrait' } });
  assert.match(detail(two, '参考图'), /2 张/);
  assert.equal(detail(two, '参考图清单').split('\n').length, 2);
});

test('谁优先真的改变上送顺序（画面：素材优先 vs 定妆照优先）', async t => {
  const { root, mats, portraits } = await fixture(t);
  let handed = null;
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: IMG_CAPS }],
    adapters: { image: { generate: async ({ referenceImages }) => { handed = referenceImages; return { status: 'succeeded', output: { type: 'image', url: '/i.png' } } } } },
  });
  // 画面只有一个入口：素材优先时送素材
  await api.runGeneration('pr', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, reference: { images: 1, prefer: 'material' } });
  const sentMaterial = Buffer.from(handed[0].split(',')[1], 'base64').at(-1);
  assert.equal(sentMaterial, 20, '素材优先 → 送素材（mood0 的标记字节是 20）');
  // 改成定妆照优先：同一个段落、同一张入口，换成定妆照
  await api.runGeneration('pr', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, reference: { images: 1, prefer: 'portrait' } });
  const sentPortrait = Buffer.from(handed[0].split(',')[1], 'base64').at(-1);
  assert.equal(sentPortrait, 10, '定妆照优先 → 送定妆照（portrait0 的标记字节是 10）');
  assert.equal(handed.length, 1, '画面只有一个入口，策略不能把它变成两张');
  assert.ok(mats.length && portraits.length);
});

test('视频能吃多张：默认定妆照在前、素材在后，张数听策略的', async t => {
  const { root } = await fixture(t, { kind: 'video', caps: VIDEO_CAPS });
  let handed = null;
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'p', id: 'vid-1', capabilities: VIDEO_CAPS }],
    adapters: { video: { generate: async ({ referenceImages }) => { handed = referenceImages; return { status: 'succeeded', output: { type: 'video', url: '/v.mp4' } } } } },
  });
  await api.runGeneration('pr', { sceneId: 's1', beatId: 'b1', kind: 'video', model: { provider: 'p', id: 'vid-1' } });
  assert.equal(handed.length, 4, '视频默认 4 张');
  const bytes = handed.map(b => Buffer.from(b.split(',')[1], 'base64').at(-1));
  assert.deepEqual(bytes.slice(0, 2), [10, 11], '定妆照在前（保人物）');
  assert.deepEqual(bytes.slice(2, 4), [20, 21], '素材在后（给场景依据）');

  await api.runGeneration('pr', { sceneId: 's1', beatId: 'b1', kind: 'video', model: { provider: 'p', id: 'vid-1' }, reference: { images: 2, prefer: 'material' } });
  assert.deepEqual(handed.map(b => Buffer.from(b.split(',')[1], 'base64').at(-1)), [20, 21], '策略说 2 张、素材优先，就只发这两张');
});

test('run 里记下这一趟用的参考图策略——事后要能回答"为什么没带定妆照"', async t => {
  const { root } = await fixture(t);
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: IMG_CAPS }],
    adapters: { image: { generate: async () => ({ status: 'succeeded', output: { type: 'image', url: '/i.png' } }) } },
  });
  const r = await api.runGeneration('pr', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, reference: { images: 1, prefer: 'portrait' } });
  assert.deepEqual(r.run.reference, { images: 1, prefer: 'portrait', used: 1 });
  const stored = (await api.get('pr')).scenes[0].outputs[0];
  assert.deepEqual(stored.reference, { images: 1, prefer: 'portrait', used: 1 });
});

// ─────────── 项目级默认配方 ───────────

test('项目默认配方是"段落没说时的兜底"：负向/参数/变体数/参考图策略都生效，显式值仍然优先', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-default-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { id: recipeId } = (await saveRecipe(root, {
    name: '项目默认', kind: 'image', model: { provider: 'p', id: 'img-1' },
    params: { size: '832x1472' }, negative: '配方负向', variants: 3, seed: 999,
    reference: { images: 2, prefer: 'portrait' },
  }, {})).recipe;
  const project = createProject({
    title: '默认配方',
    defaultRecipeId: recipeId,
    scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: '阿宁', references: [] }, { id: 'b2', kind: 'image', prompt: '老周', references: [], negative: '段落自己的负向' }], outputs: [] }],
  }, { id: () => 'pd' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({ root, getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: IMG_CAPS }] });

  const p1 = await planOf(api, {}, 'pd');
  assert.equal(detail(p1, '负向提示词').includes('配方负向'), true, '段落没写负向 → 用默认配方的');
  assert.equal(detail(p1, '参考图策略'), '2 张 · 定妆照优先', '策略也兜底');
  assert.equal(detail(p1, '上送参数').includes('832x1472'), true, '参数兜底');
  const seedShown = detail(p1, 'seed');
  assert.doesNotMatch(seedShown, /999/, '**seed 刻意不从默认配方取**：那会让每一段都是同一个 seed');
  assert.ok(Number.isFinite(Number(seedShown.split(' ')[0])), `seed 要是现掷出来的真数字，实际是「${seedShown}」`);
  assert.match(seedShown, /3 个变体/, '变体数兜底（配方说 3 版）');
  assert.match(detail(p1, '项目默认配方') || '', /项目默认/);

  // 段落自己写了 → 段落说了算
  const p2 = (await api.previewRun('pd', { sceneId: 's1', beatId: 'b2', kind: 'image', model: { provider: 'p', id: 'img-1' } })).plan;
  assert.match(detail(p2, '负向提示词'), /段落自己的负向/);
  // 显式传的 > 配方默认
  const p3 = await planOf(api, { negative: '显式负向', params: { size: '1024x1024' }, variants: 1 }, 'pd');
  assert.match(detail(p3, '负向提示词'), /显式负向/);
  assert.equal(detail(p3, '上送参数'), JSON.stringify({ size: '1024x1024', negative: '显式负向' }));
  assert.equal(detail(p3, 'seed').includes('~'), false, '显式 1 版就不该显示成变体区间');
});

test('默认配方被删了不该让项目生成不了——当作没有，不报错', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-default2-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '悬空默认', defaultRecipeId: 'rcp-已经不存在了',
    scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: 'x', references: [] }], outputs: [] }],
  }, { id: () => 'px' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({ root, getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: IMG_CAPS }] });
  const p = await planOf(api, {}, 'px');
  assert.equal(p.find(s => s.label === '项目默认配方'), undefined);
  assert.equal(detail(p, '负向提示词'), '未设置');
});

test('一键分镜产出的新段落自动盖上默认配方的类型与负向', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-default3-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { id: recipeId } = (await saveRecipe(root, { name: '整片配方', kind: 'video', negative: '水印', params: { seconds: '10' } }, {})).recipe;
  const project = createProject({ title: '盖章', defaultRecipeId: recipeId }, { id: () => 'pg' });
  await writeProject(root, project);
  // 模型故意把段落写成 image —— 默认配方说要 video，就该被盖成 video
  const text = JSON.stringify({ scenes: [{ title: 's', beats: [{ kind: 'image', prompt: '一' }, { kind: 'image', prompt: '二' }] }] });
  const api = createStoryOrchestrator({ root, directChat: async () => ({ text }), getModelList: () => [] });
  const r = await api.storyboard('pg', { idea: '试', count: 2 });
  const beats = r.project.scenes.flatMap(s => s.beats);
  assert.deepEqual(beats.map(b => b.kind), ['video', 'video'], '新段落自动套用默认配方的类型');
  assert.deepEqual(beats.map(b => b.negative), ['水印', '水印'], '负向也跟着盖上');
  // 参数**不**写进段落：那是每次生成时的选择，写进段落会变成看不见的既成事实
  assert.equal(beats[0].params, undefined);
});
