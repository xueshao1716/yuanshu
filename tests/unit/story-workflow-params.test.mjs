// 连续创作「产线参数」契约（2026-09-15）——按 ComfyUI 的产线纪律补的三样
//
// 起因是一次对照：ComfyUI 把 seed / 负向 / batch 摆在工作流上当一等公民，
// 而元枢这边——
//   * `model-probe.mjs` 给每个图/视频模型声明 `caps.seed = true`，注释写着"本管道会原样转发"；
//   * 实际上 `story-adapters` 的图像分支调 `generateImage(provider,id,prompt,size,ref)`，
//     **seed 根本没进参数**，只在提示词里插了一句 `seed=123` 文本（模型不认）；
//    视频分支连 `seed` 都没解构，`video-request` 那条 `body.seed` 分支永远走不到；
//   * 界面上根本没有 seed 输入框；负向提示词、一次多版也都不存在。
// 也就是说「固定 seed」是一项**声称支持、实际从未生效**的能力——和之前那条假降级同一类。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileStoryPrompt, negativeBlock } from '../../engine/story-prompts.mjs';
import { createImageAdapter, createVideoAdapter } from '../../engine/story-adapters.mjs';
import { createStoryOrchestrator } from '../../engine/story-orchestrator.mjs';
import { createProject, writeProject } from '../../engine/story-store.mjs';

// ─────────── seed 真的上送 ───────────

test('图像适配器必须把 seed 真的交给上游，而不是只拼进提示词', async () => {
  let got = null;
  const adapter = createImageAdapter({
    generateImage: async (provider, id, prompt, size, image, opts) => { got = { provider, id, prompt, size, opts }; return '/i.png'; },
  });
  await adapter.generate({ prompt: '画面', model: { provider: 'p', id: 'm' }, seed: 4242, params: { size: '1024x1024' } });
  assert.equal(got.opts?.seed, 4242, 'seed 必须走参数进请求体——提示词里那句 seed= 只是文字，模型不认');
  assert.equal(got.size, '1024x1024');
  // 提示词里的标记仍然保留（对不认 seed 字段的通道是个兜底），但不能是唯一手段
  assert.match(got.prompt, /seed=4242/);
});

test('视频适配器要把 seed 放进创建体（video-request 见到 src.seed 才会写 body.seed）', async () => {
  let body = null;
  const adapter = createVideoAdapter({ generateVideo: async (p, id, prompt, b) => { body = b; return { video: '/v.mp4' }; } });
  await adapter.generate({ prompt: '镜头', model: { provider: 'agnes', id: 'agnes-video-2.5-flash' }, seed: 777, params: { seconds: '5' } });
  assert.equal(body.seed, 777);
  assert.equal(body.seconds, '5');
});

test('负向提示词要真的进图像请求体（给到才带，不给不带——不赌每家上游都认这个字段）', () => {
  const src = fs.readFileSync(new URL('../../engine/media-api.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function generateImage'), src.indexOf('export async function handleImage'));
  assert.match(fn, /seed != null \? \{ seed \}/, '图像请求体要带 seed');
  assert.match(fn, /negative \? \{ negative_prompt: negative \}/, '负向要走 negative_prompt，且只在真有值时带');
});

test('run 必须记下**实际用的** seed：没指定就现掷一个，不能是 undefined', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-seed-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const project = createProject({ title: 'seed', scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: 'x', references: [] }], outputs: [] }] }, { id: () => 'p1' });
  await writeProject(root, project);
  let seen = null;
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: { image: true, reference: true, seed: true } }],
    adapters: { image: { generate: async ({ seed }) => { seen = seed; return { status: 'succeeded', output: { type: 'image', url: '/i.png' } } } } },
  });
  const a = await api.runGeneration('p1', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' } });
  assert.ok(Number.isFinite(a.run.seed), 'run.seed 不能是 undefined——否则"可复现"是句空话');
  assert.equal(seen, a.run.seed, '上送出去的 seed 与实际记录的一致');

  const b = await api.runGeneration('p1', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, seed: 99 });
  assert.equal(b.run.seed, 99, '用户指定就照用');
  assert.equal(seen, 99);
});

// ─────────── 批量变体（batch） ───────────

test('一次出 N 版：seed 依次递增，每版一条独立 run，全部落进产物历史', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-batch-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const project = createProject({ title: 'batch', scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: 'x', references: [] }], outputs: [] }] }, { id: () => 'p1' });
  await writeProject(root, project);
  const seeds = [];
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: { image: true, reference: true, seed: true } }],
    adapters: { image: { generate: async ({ seed }) => { seeds.push(seed); return { status: 'succeeded', output: { type: 'image', url: `/i-${seed}.png` } } } } },
  });
  const r = await api.runGeneration('p1', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, seed: 100, variants: 3 });
  assert.deepEqual(seeds, [100, 101, 102], '变体靠 seed 递增，不是随便掷三个');
  assert.equal(r.runs.length, 3);
  const stored = (await api.get('p1')).scenes[0].outputs;
  assert.equal(stored.length, 3, '三版都要留在产物历史里，用户才能挑');
  assert.deepEqual(stored.map(x => x.seed), [100, 101, 102]);
  assert.equal(r.run.id, r.runs[2].id, '返回的 run 是最新那一版');
});

// 这条是 2026-09-16 真机打出来的：旧断言写的是 [1000, 1001, 1002]——
// 那个范围上游根本不收（Agnes 图像接口原文：seed must be between -1 and 999），
// 于是"一次出 N 版"在真实调用里每一版都 400。测试替身不校验取值范围，
// 所以它一直是绿的：**测试绿不等于功能可用**。
test('变体 seed 不许越出上游区间：到顶绕回开头，也不能靠 400 换来一批失败', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-batch-range-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const project = createProject({ title: 'batch', scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: 'x', references: [] }], outputs: [] }] }, { id: () => 'p1' });
  await writeProject(root, project);
  const seeds = [];
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: { image: true, reference: true, seed: true } }],
    adapters: { image: { generate: async ({ seed }) => { seeds.push(seed); return { status: 'succeeded', output: { type: 'image', url: `/i-${seed}.png` } } } } },
  });
  await api.runGeneration('p1', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, seed: 998, variants: 4 });
  assert.deepEqual(seeds, [998, 999, 0, 1], '到 999 就该绕回 0，不能发出 1000/1001/1002');
  assert.ok(seeds.every(s => s >= 0 && s <= 999), '每一个发出去的 seed 都要在上游区间内');
  // 用户自己填了个越界的 seed：**夹进区间并说清楚**，run.seed 记的是实际发出去的那个
  const r2 = await api.runGeneration('p1', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, seed: 123456 });
  assert.equal(r2.run.seed, 999, '记的是实际发出去的值——不然"填 123456 能复现"就是假话');
  assert.match(r2.run.degradation.join(''), /只接受 0–999 的 seed.*123456.*999/);
});

test('变体数要有上限：批量不该变成手滑烧钱', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-batch2-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const project = createProject({ title: 'batch', scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: 'x', references: [] }], outputs: [] }] }, { id: () => 'p1' });
  await writeProject(root, project);
  let calls = 0;
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: { image: true, reference: true, seed: true } }],
    adapters: { image: { generate: async () => { calls += 1; return { status: 'succeeded', output: { type: 'image', url: '/i.png' } } } } },
  });
  await api.runGeneration('p1', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, variants: 99 });
  assert.equal(calls, 4, '上限 4 版');
  await api.runGeneration('p1', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, variants: 0 });
  assert.equal(calls, 5, '0 / 非法值退回 1 版');
});

// ─────────── 负向提示词 ───────────

test('负向提示词要进提示词块（所有通道都吃），空值不留空块', () => {
  const beat = { id: 'b1', kind: 'image', prompt: '站台', references: [] };
  const withNeg = compileStoryPrompt({ scene: {}, beat, inherited: {}, negative: '多余的手指\n文字水印' }).text;
  assert.match(withNeg, /## 必须避免/);
  assert.match(withNeg, /- 多余的手指/);
  assert.match(withNeg, /- 文字水印/);
  assert.doesNotMatch(compileStoryPrompt({ scene: {}, beat, inherited: {}, negative: '' }).text, /必须避免/);
  assert.equal(negativeBlock('   '), '');
  // 段落自带的 negative 也要生效（input 没给时回落到它）
  assert.match(compileStoryPrompt({ scene: {}, beat: { ...beat, negative: '模糊' }, inherited: {} }).text, /- 模糊/);
});

test('负向要落到 run 上并进上送参数；同参重跑才有依据', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-neg-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const project = createProject({ title: 'neg', scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: 'x', references: [] }], outputs: [] }] }, { id: () => 'p1' });
  await writeProject(root, project);
  let seen = null;
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: { image: true, reference: true, seed: true } }],
    adapters: { image: { generate: async ({ params, prompt }) => { seen = { params, prompt }; return { status: 'succeeded', output: { type: 'image', url: '/i.png' } } } } },
  });
  const r = await api.runGeneration('p1', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, negative: '水印' });
  assert.equal(seen.params.negative, '水印', '负向要进上送参数（图像通道据此发 negative_prompt）');
  assert.match(seen.prompt, /## 必须避免/);
  // 镜头规格（story-shot-prompt.mjs）要排在提示词最前面：上游对开头的权重最高
  assert.match(seen.prompt, /## 镜头规格/);
  assert.ok(seen.prompt.indexOf('## 镜头规格') < seen.prompt.indexOf('## 必须避免'), '镜头规格必须在正文之前');
  assert.equal(r.run.negative, '水印', 'run 里要记下这一趟用的负向，重跑才知道该带什么');
  assert.equal((await api.get('p1')).scenes[0].outputs[0].negative, '水印');
});

// ─────────── 执行链可见 ───────────

test('预览与实跑共用同一个 plan：预览给出的就是真正会执行的东西', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-plan-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: 'plan',
    bible: { characters: [{ id: 'c1', name: '阿宁' }] },
    scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: '阿宁在站台', references: [] }], outputs: [] }],
  }, { id: () => 'p1' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: { image: true, reference: true, seed: true } }, { provider: 'x', id: 'no-caps', capabilities: { image: true, reference: false } }],
    adapters: { image: { generate: async () => ({ status: 'succeeded', output: { type: 'image', url: '/i.png' } }) } },
  });
  const before = (await api.get('p1')).scenes[0].outputs.length;
  const pv = await api.previewRun('p1', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, seed: 5, negative: '水印' });
  assert.equal((await api.get('p1')).scenes[0].outputs.length, before, '预览绝不能落盘');
  const labels = pv.plan.map(s => s.label);
  for (const need of ['输出类型', '模型', 'seed', '参考图', '负向提示词', '上送参数']) assert.ok(labels.includes(need), `执行链里缺「${need}」`);
  assert.equal(pv.plan.find(s => s.label === 'seed').detail, '5', '预览显示的 seed 要和实跑一致');
  assert.equal(pv.plan.find(s => s.label === '负向提示词').detail, '水印');
  const run = await api.runGeneration('p1', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' }, seed: 5, negative: '水印' });
  assert.equal(run.plan.find(s => s.label === 'seed').detail, '5');
  assert.equal(run.plan.find(s => s.label === '模型').detail, 'p/img-1');
  // 声明了却做不到的能力要在执行链里被点名，而不是让人以为一切顺利
  const capped = await api.previewRun('p1', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'x', id: 'no-caps' } });
  assert.equal(capped.plan.find(s => s.label === '注意')?.detail.includes('参考资产'), true, '模型没声明参考能力要写在「注意」里');
});
