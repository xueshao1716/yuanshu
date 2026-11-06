// 原著改编（小说 → 分集大纲）契约。
//
// 这些断言锁的是**意图**，不是实现细节：
// - 解析必须宽容（真实模型给什么形状都有），但"哪几集没解析出来"必须如实回报，不能整体吞掉；
// - 段落类型由改编决定，**不能被项目默认配方一律抹平**——那是改编结果本身；
// - 一次改编要真的落成"集 + 场 + 段"，且继承链跨集串好；
// - 预览**不调模型**（不花钱），改编史要真的能读回来（新字段漏登记就写不回来，这个坑踩过三次）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAdaptPrompt, parseAdapt, parseStoryboard, cleanScenes } from '../../engine/story/assist.mjs';
import { createStoryOrchestrator } from '../../engine/story/orchestrator.mjs';
import { saveRecipe } from '../../engine/story/recipes.mjs';

const sample = (episodes = 2) => JSON.stringify({
  overview: {
    logline: '一枚旧钥匙让两个陌生人互换了人生。',
    characters: [{ name: '阿宁', appearance: '二十出头，短黑发，旧夹克' }, { name: '老周', appearance: '五十岁，微驼，灰呢帽' }],
    relationships: [{ from: '阿宁', to: '老周', note: '债主与欠债人' }],
  },
  episodes: Array.from({ length: episodes }, (_, i) => ({
    no: i + 1,
    title: `第 ${i + 1} 集 站台`,
    summary: `第 ${i + 1} 集：两人在站台相遇，结尾留下钥匙的悬念。`,
    scenes: [{
      title: `站台 ${i + 1}`,
      summary: '夜里的站台',
      slug: '外景 站台 夜',
      beats: [
        { kind: 'novel', prompt: '阿宁把钥匙塞进口袋', dialogue: [{ name: '阿宁', text: '你为什么不走？' }] },
        { kind: 'video', prompt: '老周把手里的车票撕成两半', dialogue: '老周：走哪儿。' },
      ],
    }],
  })),
});

test('改编提示词：说清集数与时长、强制要分集与台词、只返回 JSON', () => {
  const p = buildAdaptPrompt({ title: '钥匙', sourceText: '第一章…', episodes: 999, secondsPerEpisode: 5 });
  assert.match(p, /改编成 60 集/);        // 上限夹到 60
  assert.match(p, /约 15 秒/);            // 下限夹到 15
  assert.match(p, /"episodes":\[/);
  assert.match(p, /dialogue/);
  assert.match(p, /只返回 JSON/);
  assert.match(p, /不要凭空新增原著里没有的人物/);
  assert.match(p, /第一章…/);
});

test('改编解析：宽容形状（包一层 story / slug 写成字符串 / 台词是数组）', () => {
  const r = parseAdapt(sample(2));
  assert.equal(r.episodeCount, 2);
  assert.equal(r.sceneCount, 2);
  assert.equal(r.beatCount, 4);
  assert.equal(r.episodes[0].no, 1);
  assert.equal(r.episodes[0].scenes[0].slug.location, '站台');
  assert.equal(r.episodes[0].scenes[0].slug.interior, 'exterior');
  assert.equal(r.episodes[0].scenes[0].beats[0].dialogue, '阿宁：你为什么不走？');
  assert.equal(r.overview.relationships[0].from, '阿宁');
  assert.deepEqual(r.bible.characters.map(c => c.name), ['阿宁', '老周']);
  assert.deepEqual(r.failures, []);
});

test('改编解析：某几集塌了不算整体失败，但要如实说明', () => {
  const raw = `好的，以下是结果：\n\`\`\`json\n${JSON.stringify({
    episodes: [
      { no: 1, title: '有', scenes: [{ title: 'a', beats: [{ kind: 'video', prompt: '走' }] }] },
      { no: 2, title: '空的', scenes: [] },
    ],
  })}\n\`\`\``;
  const r = parseAdapt(raw);
  assert.equal(r.episodeCount, 1);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /第 2 集/);
});

test('改编解析：一个能用的集都没有时，报错要带上试过什么，便于判断是形状不符还是模型跑偏', () => {
  assert.throws(() => parseAdapt('{"foo":"bar"}'), /没有任何能用的分集场景/);
  assert.throws(() => parseAdapt(''), /不是有效 JSON/);
});

test('场景清洗只此一份：分镜与改编共用，slug 缺失时不写空字段', () => {
  const scenes = cleanScenes([{ title: 'a', beats: [{ prompt: '画面' }] }]);
  assert.deepEqual(Object.keys(scenes[0]).sort(), ['beats', 'summary', 'title']);
  const withSlug = cleanScenes([{ title: 'a', heading: 'INT. 车内 - 凌晨', beats: [{ content: '雨刷来回' }] }]);
  assert.equal(withSlug[0].slug.interior, 'interior');
  assert.equal(withSlug[0].slug.location, '车内');
  // 分镜（storyboard）与改编走的是同一个清洗：分镜那边也要能带上场次标题
  const sb = parseStoryboard(JSON.stringify({ scenes: [{ title: 's', slug: { interior: 'mixed', location: '楼道' }, beats: [{ prompt: '灯闪' }] }] }));
  assert.equal(sb.scenes[0].slug.location, '楼道');
  assert.equal(sb.scenes[0].slug.interior, 'mixed');
});

// ── 编排层：一次改编要真的落成"集 + 场 + 段" ──
async function setup(t, { recipeKind = null, chat } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-adapt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let recipeId = '';
  if (recipeKind) recipeId = (await saveRecipe(root, { name: '默认', kind: recipeKind, negative: '不要字幕' }, { now: () => '2026-09-16T00:00:00.000Z' })).recipe.id;
  const calls = [];
  const api = createStoryOrchestrator({
    root,
    clock: { id: () => Math.random().toString(36).slice(2), now: () => '2026-09-16T00:00:00.000Z' },
    readNovelBook: async ({ bookId, files }) => {
      const all = [
        { file: '第1章.md', title: '第一章', chars: 3, content: '钥匙。' },
        { file: '第2章.md', title: '第二章', chars: 3, content: '站台。' },
      ];
      return { bookId, title: '旧城纪事', chapters: Array.isArray(files) && files.length ? all.filter(c => files.includes(c.file)) : all };
    },
    directChat: chat || (async (model, prompt) => { calls.push(prompt); return { text: sample(2) } }),
    getModelList: () => [{ provider: 'p', id: 'agnes-3.0-flash', capabilities: { chat: true } }],
    getDefaultModel: () => ({ provider: 'p', id: 'agnes-3.0-flash' }),
  });
  const project = await api.create({ title: '钥匙' });
  return { root, api, project, calls, recipeId };
}

test('改编：集 / 场 / 段一次落地，场归到集，继承链跨集串好', async t => {
  const { api, project } = await setup(t);
  const r = await api.adapt(project.id, { sourceText: '原著正文', episodes: 2, secondsPerEpisode: 90, idea: '保留双男主' });
  assert.equal(r.episodeCount, 2);
  assert.equal(r.sceneCount, 2);
  assert.equal(r.beatCount, 4);
  assert.equal(r.retried, false);
  assert.equal(r.project.episodes.length, 2);
  assert.deepEqual(r.project.episodes.map(e => e.no), [1, 2]);
  // 每个场必须有归属，且归属的集真实存在
  const ids = new Set(r.project.episodes.map(e => e.id));
  for (const scene of r.project.scenes) assert.ok(ids.has(scene.episodeId), '场必须归到真实存在的集');
  assert.deepEqual(r.project.scenes.map(s => s.episodeId), [r.project.episodes[0].id, r.project.episodes[1].id]);
  // 继承链跨集：第 2 集第 1 段承接第 1 集最后一段
  const beats = r.project.scenes.flatMap(s => s.beats);
  assert.equal(beats.length, 4);
  assert.equal(beats[0].inheritFromBeatId, undefined);
  assert.equal(beats[1].inheritFromBeatId, beats[0].id);
  assert.equal(beats[2].inheritFromBeatId, beats[1].id, '要跨集承接，不能到下一集就断链');
  // 台词与角色引用都要挂上
  assert.equal(beats[0].dialogue, '阿宁：你为什么不走？');
  assert.ok(beats[0].references.some(x => x.role === 'character'));
  assert.equal(r.characters, 2);
  assert.equal(r.project.logline, '一枚旧钥匙让两个陌生人互换了人生。');
});

test('改编：段落类型由改编决定，项目默认配方的 kind 不得把它抹平（负向照旧套用）', async (t) => {
  const { api, project, recipeId } = await setup(t, { recipeKind: 'image' });
  assert.ok(recipeId, '配方要先真的存下来（saveRecipe 自己发 id，不能假定）');
  await api.patch(project.id, { defaultRecipeId: recipeId });
  const r = await api.adapt(project.id, { sourceText: '原著正文', episodes: 2 });
  const kinds = r.project.scenes.flatMap(s => s.beats).map(b => b.kind);
  assert.deepEqual(kinds, ['novel', 'video', 'novel', 'video'], '改编给的 novel/video 分工必须保留');
  assert.ok(r.project.scenes.flatMap(s => s.beats).every(b => b.negative === '不要字幕'), '负向是工艺，照旧套用');
});

test('改编：预览只读书、一次模型调用都不发，并说清会截断多少字', async (t) => {
  const { api, project, calls } = await setup(t);
  const r = await api.adapt(project.id, { bookId: 'b1', episodes: 3, preview: true });
  assert.equal(r.preview, true);
  assert.equal(calls.length, 0, '预览绝不能调模型');
  assert.equal(r.source.chars, '# 第一章\n钥匙。\n\n# 第二章\n站台。'.length, '字数要按实际拼出的原文算');
  assert.equal(r.source.chapters.length, 2);
  assert.equal(r.episodeWish, 3);
  assert.match(r.note, /3 集/);
  assert.equal((await api.get(project.id)).scenes.length, 0, '预览不写盘');
});

test('改编：从小说工坊按书导入，改编史能读回来（新字段漏登记就写不回来）', async t => {
  const { api, project } = await setup(t);
  const r = await api.adapt(project.id, { bookId: 'b1', chapterFiles: ['第2章.md'], episodes: 1 });
  assert.equal(r.source.kind, 'novel');
  assert.equal(r.source.title, '旧城纪事');
  assert.equal(r.source.chapters.length, 1);
  assert.equal(r.source.chapters[0].file, '第2章.md');
  const reread = await api.get(project.id);
  assert.equal(reread.adaptations.length, 1);
  assert.equal(reread.adaptations[0].source.bookId, 'b1');
  assert.equal(reread.adaptations[0].episodeCount, r.episodeCount);
  assert.equal(reread.adaptations[0].relationships[0].note, '债主与欠债人');
  assert.equal(reread.adaptations[0].episodeIds.length, r.project.episodes.length);
  assert.equal(reread.adaptations[0].model.id, 'agnes-3.0-flash');
});

test('改编：模型第一次集数不给够时自动再要一次，并如实上报', async (t) => {
  let n = 0;
  const calls = [];
  const { api, project } = await setup(t, {
    chat: async (model, prompt) => { calls.push(prompt); n += 1; return { text: n === 1 ? sample(1) : sample(4) } },
  });
  const r = await api.adapt(project.id, { sourceText: '原著', episodes: 4 });
  assert.equal(r.attempts, 2);
  assert.equal(r.retried, true);
  assert.equal(r.firstEpisodeCount, 1);
  assert.equal(r.episodeCount, 4);
  assert.match(calls[1], /上一次你只给了 1 集/);
});

test('改编：没有原文 / 引擎未接入时必须是能看懂的错误，不能静默变成空操作', async (t) => {
  const { root, api, project } = await setup(t);
  await assert.rejects(() => api.adapt(project.id, {}), /没有可改编的原文/);
  const bare = createStoryOrchestrator({ root });
  await assert.rejects(() => bare.adapt(project.id, { sourceText: '有原文' }), /改编引擎未接入/);
  await assert.rejects(() => bare.adapt(project.id, { bookId: 'b1' }), /小说工坊未接入/);
});

test('改编：新增集从既有集的编号之后接着排，不覆盖手工建的集', async (t) => {
  const { api, project } = await setup(t);
  const made = await api.addEpisode(project.id, { title: '手工第 1 集' });
  assert.equal(made.episode.no, 1);
  const r = await api.adapt(project.id, { sourceText: '原著', episodes: 2 });
  assert.deepEqual(r.project.episodes.map(e => e.no), [1, 2, 3]);
  assert.equal(r.project.episodes[0].title, '手工第 1 集');
});
