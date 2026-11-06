// 创作方法包（Skill）契约。
//
// 来源：Lovart 最值得抄的一条不是"接了多少模型"，而是**方法包**——封装的是
// "完成一个创作任务的整套方法"（任务怎么拆、按什么顺序、遵循什么标准、交付要满足什么），
// 而且用户跑通的一次过程能一键存成个人 Skill。
// 元枢此前的"配方"只存工艺参数，方法（一集多长/每集几场/结尾要不要钩子）没有任何落点。
//
// 这里锁四件事：
// - 内置方法包不可改不可删（改它等于改所有项目的标准，升级还会被覆盖）；
// - 方法包**只给建议**：不覆盖用户自己排过的集时长、不覆盖人工调好的画风；
// - 从项目反推的方法包只抄结构、不抄内容（抄了内容就不能跨项目用）；
// - 方法包真的进到提示词与调用预算里——否则它就是一段没人读的说明。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_METHODS, listMethods, methodOf, saveMethod, deleteMethod, captureFromProject, methodBrief, reasoningBudget, normalizeMethod } from '../../engine/story/methods.mjs';
import { createStoryOrchestrator } from '../../engine/story/orchestrator.mjs';
import { createProject } from '../../engine/story/store.mjs';

const root = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-method-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

test('内置方法包：每个都有真的能执行的方法，不是文案', () => {
  assert.equal(BUILTIN_METHODS.length, 4);
  for (const m of BUILTIN_METHODS) {
    assert.ok(m.name && m.goal, `${m.id} 要有名字与目标`);
    assert.ok(m.steps.length >= 3, `${m.id} 的步骤要真的拆开（至少 3 步）`);
    assert.ok(m.checklist.length >= 3, `${m.id} 要有交付前真能逐条看的自检项`);
    assert.ok(m.targetSeconds > 0 && m.scenesPerEpisode > 0 && m.beatsPerScene > 0, `${m.id} 要给出结构建议`);
    assert.ok(['fast', 'thinking'].includes(m.reasoning), `${m.id} 要说清推理档位`);
    // 步骤必须对应界面上真的有的动作（素材挂载/画风预设/一键分镜/分集/批量/批量出片/剧本导出/试戏），
    // 否则方法包会被当成"又一个 PPT"
    const text = m.steps.map(s => s.title + s.detail).join('');
    assert.match(text, /素材|挂上|画风预设|预设|分镜|分集|批量|出片|剧本|定妆照|原著|场景|试戏|导出/, `${m.id} 的步骤要落到元枢真有的动作上`);
  }
  assert.equal(new Set(BUILTIN_METHODS.map(m => m.id)).size, BUILTIN_METHODS.length, 'id 不能重复');
});

test('内置不可改不可删：要改就复制成自己的（升级不会覆盖用户的东西）', async t => {
  const dir = await root(t);
  await assert.rejects(() => saveMethod(dir, { id: BUILTIN_METHODS[0].id, name: '我改的' }), /内置方法包不能改/);
  await assert.rejects(() => deleteMethod(dir, BUILTIN_METHODS[0].id), /内置方法包不能删/);
  const saved = await saveMethod(dir, { name: '我的短剧打法', steps: [{ title: '一', detail: '二' }] }, { id: () => 'm1' });
  assert.equal(saved.method.id, 'm1');
  assert.equal(saved.method.source, 'user');
  const list = await listMethods(dir);
  assert.equal(list.length, BUILTIN_METHODS.length + 1);
  assert.ok(list.some(m => m.id === 'm1'));
  // 重名不该产生两个：同名保存是**覆盖自己那份**，不是叠加
  await saveMethod(dir, { id: 'm1', name: '我的短剧打法 v2' }, {});
  assert.equal((await listMethods(dir)).length, BUILTIN_METHODS.length + 1);
  assert.equal((await methodOf(dir, 'm1')).name, '我的短剧打法 v2');
  const del = await deleteMethod(dir, 'm1');
  assert.equal(del.ok, true);
  assert.equal((await listMethods(dir)).length, BUILTIN_METHODS.length);
});

test('从项目反推方法包：只抄结构与配比，不抄提示词/台词（方法要能跨项目用）', () => {
  const project = createProject({
    title: '站台',
    episodes: [{ id: 'e1', no: 1, title: '一', summary: '', targetSeconds: 60 }],
    scenes: [{ id: 's1', beats: [{ id: 'b1', kind: 'video', prompt: '雨夜的旧站台，阿宁提着行李' }, { id: 'b2', kind: 'novel', prompt: '她想起钥匙' }] }],
  }, { id: () => 'p' });
  const m = captureFromProject(project, { name: '我的站台打法' });
  assert.equal(m.name, '我的站台打法');
  assert.equal(m.source, 'project');
  assert.equal(m.targetSeconds, 60, '集上写过的目标时长要继承');
  assert.equal(m.scenesPerEpisode, 1);
  assert.equal(m.beatsPerScene, 2);
  assert.match(m.goal, /1 集.*1 场.*2 段/s);
  const all = JSON.stringify(m);
  assert.ok(!all.includes('雨夜的旧站台'), '不许把这一段的提示词抄进方法包');
  assert.ok(!all.includes('她想起钥匙'), '不许把正文/台词抄进方法包');
});

test('方法说明进提示词：空项不出现，有内容的才写；推理档位决定调用预算', () => {
  const empty = normalizeMethod({ name: '空方法' });
  const brief = methodBrief(empty);
  assert.match(brief, /创作方法：空方法/);
  assert.ok(!brief.includes('必须遵守'), '没写规则就不要出现空的"必须遵守"标题');
  const full = normalizeMethod({ name: '竖屏短剧', goal: '90 秒一集', targetSeconds: 90, scenesPerEpisode: 6, beatsPerScene: 3, rules: ['前 3 秒出冲突'] });
  const b2 = methodBrief(full);
  assert.match(b2, /单集目标 90 秒/);
  assert.match(b2, /每集约 6 场/);
  assert.match(b2, /前 3 秒出冲突/);
  assert.equal(methodBrief(null), '');
  assert.deepEqual(reasoningBudget('fast', 'storyboard'), { maxTokens: 3000, timeout: 90000 });
  assert.deepEqual(reasoningBudget('thinking', 'storyboard'), { maxTokens: 6000, timeout: 180000 });
  assert.deepEqual(reasoningBudget('fast', 'adapt'), { maxTokens: 8000, timeout: 180000 });
  assert.deepEqual(reasoningBudget('thinking', 'adapt'), { maxTokens: 16000, timeout: 300000 });
  assert.deepEqual(reasoningBudget(undefined, 'adapt'), reasoningBudget('fast', 'adapt'), '没写档位就按快档');
});

test('套用方法包：只写结构，不覆盖用户自己排过的集时长与人工调好的画风', async t => {
  const dir = await root(t);
  const api = createStoryOrchestrator({ root: dir, clock: { id: () => 'p1', now: () => 'T' } });
  const project = await api.create({
    title: '钥匙',
    bible: { characters: [], style: { visual: '人工调好的水墨' } },
    episodes: [{ id: 'e1', no: 1, title: '一', summary: '' }, { id: 'e2', no: 2, title: '二', summary: '', targetSeconds: 45 }],
  });
  const r = await api.applyMethod(project.id, { methodId: 'builtin-short-drama-vertical' });
  assert.equal(r.project.methodId, 'builtin-short-drama-vertical');
  const eps = (await api.get(project.id)).episodes;
  assert.equal(eps.find(e => e.id === 'e1').targetSeconds, 90, '没排过时长的集才写方法包的目标时长');
  assert.equal(eps.find(e => e.id === 'e2').targetSeconds, 45, '用户自己排过的时长不许被覆盖');
  assert.equal(r.applied.episodes, 1);
  assert.equal(r.applied.style, false);
  assert.equal((await api.get(project.id)).bible.style.visual, '人工调好的水墨', '人工调好的画风优先');
  // 解除
  const off = await api.applyMethod(project.id, { methodId: '' });
  assert.equal(off.project.methodId, undefined);
  assert.equal((await api.get(project.id)).methodId, undefined, '解除也要能读回来（白名单里登记过）');
  await assert.rejects(() => api.applyMethod(project.id, { methodId: '不存在' }), /这个方法包不存在/);
});

test('项目上挂着的方法包真的进了提示词与调用预算（否则它只是一段没人读的说明）', async t => {
  const dir = await root(t);
  const seen = [];
  const api = createStoryOrchestrator({
    root: dir,
    clock: { id: () => 'p1', now: () => 'T' },
    directChat: async (model, prompt, history, opts) => { seen.push({ prompt, opts }); return { text: JSON.stringify({ bible: { characters: [] }, scenes: [{ title: 's', beats: [{ kind: 'video', prompt: 'x' }] }] }) } },
    getModelList: () => [{ provider: 'p', id: 'agnes-3.0-flash', capabilities: { chat: true } }],
    getDefaultModel: () => ({ provider: 'p', id: 'agnes-3.0-flash' }),
  });
  const project = await api.create({ title: '钥匙' });
  // 没有方法包时：按快档
  await api.storyboard(project.id, { idea: '开场', count: 4 });
  assert.deepEqual(seen.at(-1).opts, reasoningBudget('fast', 'storyboard'));
  assert.ok(!seen.at(-1).prompt.includes('创作方法：'));
  // 挂上"小说改编成短剧"（thinking 档）：提示词里要有方法与规则，预算要放大
  await api.applyMethod(project.id, { methodId: 'builtin-novel-to-90s' });
  await api.storyboard(project.id, { idea: '开场', count: 4 });
  const last = seen.at(-1);
  assert.match(last.prompt, /创作方法：小说改编成短剧/);
  assert.match(last.prompt, /保留原著主线与关键转折/, '方法包的规则必须真的进提示词');
  assert.match(last.prompt, /每场约 3 段/);
  assert.deepEqual(last.opts, reasoningBudget('thinking', 'storyboard'), 'thinking 档要真的多给输出余量');
});

test('方法包文件坏了也不该让创作台打不开（只有内置可用）', async t => {
  const dir = await root(t);
  await fs.writeFile(path.join(dir, 'story-methods.json'), '{ 这不是 JSON', 'utf8');
  const list = await listMethods(dir);
  assert.equal(list.length, BUILTIN_METHODS.length);
  assert.equal((await methodOf(dir, 'builtin-brand-film')).name, '品牌短片（30 秒）');
});
