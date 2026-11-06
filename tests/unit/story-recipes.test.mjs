// 生成配方（对标 ComfyUI「工作流即资产」）契约
//
// 在 ComfyUI 里你把一张调好的节点图存下来，换个项目/换台机器/发给同事，只改提示词就能复现
// 同一套处理方式——`File → Export (API)` 那份 JSON 就是这件资产。
// 元枢此前每次生成都要重选模型、重填负向、重设变体数，同一部片子 10 个段落要点 10 遍，
// 跨项目更是完全无法复用。配方把"调好的生成设置"变成可存/套用/导出/导入的具名数据。
//
// 边界（刻意的）：配方**只存工艺，不存故事**——不存提示词、台词、素材。
// 混进去就变成"换个配方顺手把台词也换了"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeRecipe, listRecipes, saveRecipe, deleteRecipe, exportRecipes,
  parseRecipeImport, importRecipes, RECIPE_FORMAT, RECIPE_FORMAT_VERSION,
} from '../../engine/story/recipes.mjs';
import * as mod from '../../engine/story/recipes.mjs';

const tmpRoot = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-recipes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

test('配方要有名字；kind 兜底、params 清洗、seed/variants 收敛', () => {
  assert.throws(() => normalizeRecipe({ kind: 'image' }), /名字/);
  const r = normalizeRecipe({ name: '  夜景  ', kind: 'nope', params: { size: '1024x1024', seconds: '', n: null, bad: 'x' }, variants: 99, seed: '42' });
  assert.equal(r.name, '夜景');
  assert.equal(r.kind, 'image', '非法 kind 落到默认，而不是存进去一个用不了的值');
  assert.deepEqual(r.params, { size: '1024x1024', bad: 'x' }, '空值参数不该留在配方里');
  assert.equal(r.variants, 4, '变体数收敛到 1–4');
  assert.equal(r.seed, 42, 'seed 存成数字，空字符串等于"没锁"');
  assert.equal(normalizeRecipe({ name: 'x' }).seed, null);
  assert.deepEqual(normalizeRecipe({ name: 'x' }).model, { provider: 'auto', id: 'auto' });
});

test('存/列/删：同名覆盖、按更新时间倒序、删不存在的如实回报', async t => {
  const root = await tmpRoot(t);
  await saveRecipe(root, { name: '夜景', kind: 'image', negative: '水印' }, { now: () => '2026-09-15T01:00:00.000Z' });
  await saveRecipe(root, { name: '白天', kind: 'video' }, { now: () => '2026-09-15T02:00:00.000Z' });
  let list = await listRecipes(root);
  assert.deepEqual(list.map(r => r.name), ['白天', '夜景'], '新的在前');

  // 同名再存一次 = 更新它，而不是多出一份
  const again = await saveRecipe(root, { name: '夜景', kind: 'image', negative: '多余的手指' }, { now: () => '2026-09-15T03:00:00.000Z' });
  assert.equal(again.recipes.length, 2, '同名覆盖，不是新增');
  assert.equal(again.recipe.negative, '多余的手指');
  assert.equal(again.recipe.createdAt, '2026-09-15T01:00:00.000Z', 'createdAt 要保留，否则看不出它是什么时候建的');

  assert.deepEqual((await listRecipes(root, { kind: 'video' })).map(r => r.name), ['白天'], '可以按类型筛');
  const del = await deleteRecipe(root, again.recipe.id);
  assert.equal(del.ok, true);
  assert.deepEqual(del.recipes.map(r => r.name), ['白天']);
  const miss = await deleteRecipe(root, 'rcp-不存在');
  assert.equal(miss.ok, false, '删不存在的要说没删到，不能装作成功');
  assert.equal((await listRecipes(root)).length, 1);
});

test('配方文件坏了要报出来，不能装作"没有配方"', async t => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'story-recipes.json'), '{ 这不是 json', 'utf8');
  await assert.rejects(() => listRecipes(root), /配方文件读不出来/, '装作没有配方 = 让用户以为自己的配方凭空消失');
});

test('导出是自足的一份文件；能认三种导入形状，坏条目逐条如实跳过', () => {
  const one = normalizeRecipe({ name: 'A', kind: 'image' });
  const out = exportRecipes([one], { now: () => '2026-09-15T00:00:00.000Z' });
  assert.equal(out.format, RECIPE_FORMAT);
  assert.equal(out.version, RECIPE_FORMAT_VERSION);
  assert.equal(out.exportedAt, '2026-09-15T00:00:00.000Z');
  assert.equal(out.recipes.length, 1);

  assert.equal(parseRecipeImport(out).recipes.length, 1, '导出文件');
  assert.equal(parseRecipeImport([{ name: 'B' }]).recipes.length, 1, '裸数组（别人手写的常见形状）');
  assert.equal(parseRecipeImport({ name: 'C' }).recipes.length, 1, '单个配方对象');

  const mixed = parseRecipeImport({ recipes: [{ name: 'ok' }, { kind: 'image' }, null] });
  assert.deepEqual(mixed.recipes.map(r => r.name), ['ok']);
  assert.equal(mixed.skipped.length, 2, '坏条目要逐条报出来（含无名的那条），不静默丢弃');
  assert.throws(() => parseRecipeImport({ recipes: [] }), /没有可导入的配方/);
});

test('导入：同名覆盖、不同名新增，并回报每条去向', async t => {
  const root = await tmpRoot(t);
  await saveRecipe(root, { name: '夜景', kind: 'image', negative: '旧' }, { now: () => '2026-09-15T01:00:00.000Z' });
  const payload = exportRecipes([
    normalizeRecipe({ name: '夜景', kind: 'image', negative: '新' }),
    normalizeRecipe({ name: '白天', kind: 'video' }),
  ], { now: () => '2026-09-15T02:00:00.000Z' });
  const r = await importRecipes(root, payload, { now: () => '2026-09-15T03:00:00.000Z' });
  assert.equal(r.added, 1);
  assert.equal(r.updated, 1);
  const list = await listRecipes(root);
  assert.equal(list.length, 2);
  assert.equal(list.find(x => x.name === '夜景').negative, '新', '同名覆盖');
  assert.equal(list.find(x => x.name === '夜景').createdAt, '2026-09-15T01:00:00.000Z');
});

test('配方跨项目：存在工作区根，不在任何一个项目里', async t => {
  const root = await tmpRoot(t);
  await fs.mkdir(path.join(root, 'story-projects'), { recursive: true });
  await saveRecipe(root, { name: '跨项目' });
  assert.ok((await fs.readdir(root)).includes('story-recipes.json'), '换项目还看得见，才叫可复用');
  assert.deepEqual(await fs.readdir(path.join(root, 'story-projects')), []);
});

// 参考图策略：用几张、谁优先。以前这条策略硬编码在编排层里，用户在界面上既看不到也改不了。
test('参考图策略的默认值要跟"用户显式做了什么"对齐', () => {
  const { defaultRefStrategy, normalizeRefStrategy } = mod;
  assert.deepEqual(defaultRefStrategy('image'), { images: 1, prefer: 'material' },
    '画面只有一个入口：用户显式挂的素材必须优先，否则"挂了却没发生"是最坏的静默失败');
  assert.deepEqual(defaultRefStrategy('video'), { images: 4, prefer: 'portrait' },
    '视频能吃多张：先保人物（定妆照），素材跟在后面给场景依据');
  assert.deepEqual(defaultRefStrategy('novel'), { images: 0, prefer: 'portrait' });
  // 收敛与兜底
  assert.deepEqual(normalizeRefStrategy({ images: 9, prefer: '乱写' }, 'image'), { images: 4, prefer: 'material' });
  assert.deepEqual(normalizeRefStrategy({ images: -3 }, 'video'), { images: 0, prefer: 'portrait' }, '0 是合法值=明确不用参考图');
  assert.deepEqual(normalizeRefStrategy(undefined, 'video'), { images: 4, prefer: 'portrait' });
  const saved = normalizeRecipe({ name: '策略', kind: 'image', reference: { images: 2, prefer: 'portrait' } });
  assert.deepEqual(saved.reference, { images: 2, prefer: 'portrait' }, '策略要能存进配方');
  assert.deepEqual(normalizeRecipe({ name: '默认策略', kind: 'video' }).reference, { images: 4, prefer: 'portrait' });
});

// seed 有三态：null/undefined/'' = 没锁；0 是**合法 seed**。第一版把 null 走进了 Number(null)===0
// 这条分支，"没锁"静默变成了"锁死 0"——界面探针上表现为配方卡凭空显示 `seed 0`。
test('seed 的三态：null/undefined/空串都是"没锁"，但 0 是合法 seed', () => {
  assert.equal(normalizeRecipe({ name: 'a', seed: null }).seed, null, '前端传 null = 没锁，不能变成 0');
  assert.equal(normalizeRecipe({ name: 'b' }).seed, null);
  assert.equal(normalizeRecipe({ name: 'c', seed: '' }).seed, null);
  assert.equal(normalizeRecipe({ name: 'd', seed: '   ' }).seed, null);
  assert.equal(normalizeRecipe({ name: 'e', seed: 0 }).seed, 0, '0 是真 seed，不能被当成"没锁"');
  assert.equal(normalizeRecipe({ name: 'f', seed: '0' }).seed, 0);
  assert.equal(normalizeRecipe({ name: 'g', seed: 12345 }).seed, 12345);
  assert.equal(normalizeRecipe({ name: 'h', seed: 'abc' }).seed, null, '不是数字就别装作锁了');
});
