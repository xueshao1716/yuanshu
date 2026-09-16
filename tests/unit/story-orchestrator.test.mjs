import test from 'node:test';
import assert from 'node:assert/strict';
import { negotiateCapabilities, createGenerationRun, appendRun, createStoryOrchestrator } from '../../engine/story-orchestrator.mjs';
import { createProject, writeProject, readProject, sweepInterruptedRuns } from '../../engine/story-store.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 按 root+id 读写项目的小包装（sweep 的测试要独立核对磁盘上的结果）
const api0 = {
  get: (root, id) => readProject(root, id),
  create: async (root, input) => { const p = createProject(input, { id: () => `p-${Date.now().toString(36)}` }); await writeProject(root, p); return p },
};

test('preview is read-only and a continuing novel receives the actual previous prose', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-continuity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({title:'连续测试',scenes:[{id:'s',beats:[{id:'b1',kind:'novel',prompt:'开端',references:[]},{id:'b2',kind:'novel',prompt:'继续',inheritFromBeatId:'b1',references:[]}],outputs:[{id:'r0',beatId:'b1',status:'succeeded',outputAssets:[{id:'text0',type:'text',text:'她把钥匙藏进蓝色信封。'}]}]}]}, {id:()=> 'p'});
  await writeProject(root, project);
  let prompt;
  const api=createStoryOrchestrator({root,adapters:{novel:{generate:async input=>{prompt=input.prompt;return {status:'succeeded',output:{type:'text',text:'续文'}}}}}});
  await api.previewRun('p',{sceneId:'s',beatId:'b2',kind:'novel'});
  assert.equal((await api.get('p')).scenes[0].outputs.length,1,'preview must not create fake queued jobs');
  await api.runGeneration('p',{sceneId:'s',beatId:'b2',kind:'novel'});
  assert.match(prompt,/她把钥匙藏进蓝色信封/);
});

test('negotiateCapabilities reports unsupported reference and seed', () => {
  const r = negotiateCapabilities({ reference: true, keyframe: false, seed: true }, { reference: false, keyframe: false, seed: false });
  assert.deepEqual(r.degradation, ['reference: 当前模型不支持参考资产', 'seed: 当前模型不支持固定 seed']);
});

test('createGenerationRun records immutable parent and normalized status', () => {
  const r = createGenerationRun({ projectId: 'p1', sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'local', id: 'flux' }, params: { width: 1024 }, seed: 42, inputAssets: [{ id: 'a1', role: 'character' }], parentRunId: 'old' }, { id: () => 'run1', now: () => '2026-09-12T08:00:00.000Z' });
  assert.equal(r.id, 'run1');
  assert.equal(r.status, 'queued');
  assert.equal(r.parentRunId, 'old');
  assert.equal(r.seed, 42);
});

test('appendRun keeps previous runs and updates active run', () => {
  const scene = { outputs: [] };
  appendRun(scene, { id: 'r1', status: 'succeeded' });
  assert.equal(scene.outputs.length, 1);
  assert.equal(scene.activeRunId, 'r1');
});

test('runGeneration executes adapter and persists output with status', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-'));
  const project = createProject({ title: '测试故事', scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'novel', prompt: '写一段', references: [] }], outputs: [] }] }, { id: () => 'p1', now: () => '2026-09-12T08:00:00.000Z' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({ root, clock: { id: () => 'r1', now: () => '2026-09-12T08:01:00.000Z' }, adapters: { novel: { generate: async () => ({ status: 'succeeded', output: { type: 'text', text: '正文' } }) } } });
  const result = await api.runGeneration('p1', { sceneId: 's1', beatId: 'b1', kind: 'novel', model: { provider: 'p', id: 'm' } });
  assert.equal(result.run.status, 'succeeded');
  assert.equal(result.run.outputAssets[0].type, 'text');
  assert.equal(result.project.scenes[0].outputs[0].status, 'succeeded');
});

test('unexpected adapter failure finishes and records a failed run instead of leaving it running', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const api=createStoryOrchestrator({root,adapters:{novel:{generate:async()=>{throw new Error('通道中断')}}}});
  const p=await api.create({title:'临时错误测试',scenes:[{id:'s',beats:[{id:'b',kind:'novel',prompt:'开场',references:[]}],outputs:[]}]});
  const result=await api.runGeneration(p.id,{sceneId:'s',beatId:'b',kind:'novel'});
  assert.equal(result.run.status,'failed');
  assert.ok(result.run.finishedAt);
  assert.ok(result.run.degradation.includes('通道中断'));
  assert.equal((await api.get(p.id)).scenes[0].outputs[0].status,'failed');
});

// 2026-09-15 实测故障：显式选中的模型只有 {provider,id}（前端下拉就这么给），capabilities
// 整个丢掉，negotiateCapabilities 于是对**每个显式选中的模型**报「当前模型不支持参考资产」——
// 参考图通路被一条假降级关掉。真实项目里 4 次视频运行正是这样"成功但没带参考图"。
test('显式选中的模型要从目录补回 capabilities，不再无差别误报「不支持参考资产」', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-caps-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '能力补齐',
    bible: { characters: [{ id: 'c1', name: '阿宁' }] },
    scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'video', prompt: '阿宁站在站台', references: [] }], outputs: [] }],
  }, { id: () => 'pc' });
  await writeProject(root, project);
  let seenModel;
  const api = createStoryOrchestrator({
    root,
    // 前端下拉只会给这两个字段
    getModelList: () => [{ provider: 'agnes', id: 'agnes-video-2.5-flash', capabilities: { chat: false, video: true, reference: true, keyframe: true, seed: true } }],
    adapters: { video: { generate: async ({ model }) => { seenModel = model; return { status: 'succeeded', output: { type: 'video', url: '/v.mp4' } }; } } },
  });
  const result = await api.runGeneration('pc', { sceneId: 's1', beatId: 'b1', kind: 'video', model: { provider: 'agnes', id: 'agnes-video-2.5-flash' } });
  assert.equal(result.run.capabilities.reference, true, '显式选模型不能把参考图能力抹掉');
  assert.equal(result.run.capabilities.keyframe, true);
  assert.deepEqual(result.run.degradation, undefined, '能力齐备时不该有任何降级提示');
  assert.equal(result.run.status, 'succeeded');
  assert.ok(seenModel.capabilities?.reference, '适配器拿到的模型必须带着能力，否则它也没法决定要不要注入参考图');
});

// 参考图是元枢自己的文件地址，上游只认公网 http(s) 或 base64（见 engine/media-inline.mjs）。
// 这一条把「编排层内联 → 上送 base64」和「项目里仍记原始引用」两件事一起锁住：
// 记录里存 base64 会让项目 JSON 被撑爆（一张定妆照就是 2MB 级）。
test('参考图上送前内联成 base64，但写进项目历史的仍是原始引用', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-ref-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const refFile = path.join(root, '生成物', '图片', 'portrait.png');
  await fs.mkdir(path.dirname(refFile), { recursive: true });
  await fs.writeFile(refFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));
  const refUrl = `/api/ws/file?path=${encodeURIComponent(path.relative(root, refFile))}`;
  const project = createProject({
    title: '参考图内联',
    bible: { characters: [{ id: 'c1', name: '阿宁', refImage: refUrl }] },
    scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'video', prompt: '阿宁站在站台', references: [] }], outputs: [] }],
  }, { id: () => 'pr' });
  await writeProject(root, project);
  let handed;
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'agnes', id: 'agnes-video-2.5-flash', capabilities: { video: true, reference: true, keyframe: true, seed: true } }],
    adapters: { video: { generate: async ({ referenceImages }) => { handed = referenceImages; return { status: 'succeeded', output: { type: 'video', url: '/v.mp4' } }; } } },
  });
  const result = await api.runGeneration('pr', { sceneId: 's1', beatId: 'b1', kind: 'video', model: { provider: 'agnes', id: 'agnes-video-2.5-flash' } });
  assert.equal(handed.length, 1);
  assert.match(handed[0], /^data:image\/png;base64,/, '发给上游的必须是上游认的形式');
  assert.equal(result.run.referenceImages[0], refUrl, '产物历史里记的是原始引用，不是 2MB 的 base64');
  const reread = await api.get('pr');
  assert.ok(JSON.stringify(reread).length < 20000, '项目 JSON 不能因为内联而膨胀');
  assert.equal(reread.scenes[0].outputs[0].referenceImages[0], refUrl);
});

test('参考图落不下来时摘掉并如实降级，不静默发一趟没有参考图的请求', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-refbad-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '参考图缺失',
    bible: { characters: [{ id: 'c1', name: '阿宁', refImage: '/api/ws/file?path=%E6%B2%A1%E6%9C%89%E8%BF%99%E5%BC%A0.png' }] },
    scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'video', prompt: '阿宁站在站台', references: [] }], outputs: [] }],
  }, { id: () => 'pb' });
  await writeProject(root, project);
  let handed = 'never-called';
  const api = createStoryOrchestrator({
    root,
    getModelList: () => [{ provider: 'agnes', id: 'agnes-video-2.5-flash', capabilities: { video: true, reference: true, keyframe: true, seed: true } }],
    adapters: { video: { generate: async ({ referenceImages }) => { handed = referenceImages; return { status: 'succeeded', output: { type: 'video', url: '/v.mp4' } }; } } },
  });
  const result = await api.runGeneration('pb', { sceneId: 's1', beatId: 'b1', kind: 'video', model: { provider: 'agnes', id: 'agnes-video-2.5-flash' } });
  assert.deepEqual(handed, [], '拿不到参考图就不该硬塞一个无效地址过去（那正是 400 的来源）');
  assert.equal(result.run.status, 'degraded', '没带参考图却报"成功"，用户会以为人物已经锁定了');
  assert.ok(result.run.degradation.some(d => d.includes('参考图未上送')), `降级原因里要写清为什么：${JSON.stringify(result.run.degradation)}`);
});

// 上游在创建阶段摘掉参考图时会把原因放在 notes 里（media-api.startVideoJob）。
// 适配器要如实转成 output.degradation，编排层要并进 run.degradation——否则那一趟看起来是"成功"。
test('适配器上报的降级要并进 run.degradation，而不是停在 output 里没人看', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-notes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '降级上报',
    scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'video', prompt: '开场', references: [] }], outputs: [] }],
  }, { id: () => 'pn' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({
    root,
    adapters: { video: { generate: async () => ({ status: 'succeeded', output: { type: 'video', url: '/v.mp4', degradation: ['参考图未上送：上游拒绝了这张图'] } }) } },
  });
  const result = await api.runGeneration('pn', { sceneId: 's1', beatId: 'b1', kind: 'video' });
  assert.equal(result.run.status, 'degraded');
  assert.ok(result.run.degradation.includes('参考图未上送：上游拒绝了这张图'));
});

// 孤儿运行：状态还是 running、但没有 finishedAt 的那些——持有它的进程已经死了，
// 不清理就会永远显示「正在生成」（真实案例：用户项目里挂着一条 07:40:12 的 running，
// 被重启服务打断，既不会成功也不会失败）。启动这一刻判它，是确定的，不需要超时猜测。
test('启动时清理被中断的运行：running 且无 finishedAt → failed，并说清原因', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-orphan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '孤儿',
    scenes: [{
      id: 's1', index: 1, title: '一', summary: '',
      beats: [{ id: 'b1', kind: 'video', prompt: 'x', references: [] }, { id: 'b2', kind: 'image', prompt: 'y', references: [] }],
      outputs: [
        { id: 'r-running', beatId: 'b1', kind: 'video', status: 'running', createdAt: '2026-09-15T07:40:12.000Z' },
        { id: 'r-done', beatId: 'b2', kind: 'image', status: 'succeeded', createdAt: '2026-09-15T07:00:00.000Z', finishedAt: '2026-09-15T07:01:00.000Z' },
        // running 但有 finishedAt：形状不完整但不是孤儿（收尾写过一半），不该被动
        { id: 'r-odd', beatId: 'b2', kind: 'image', status: 'running', createdAt: '2026-09-15T07:02:00.000Z', finishedAt: '2026-09-15T07:03:00.000Z' },
      ],
    }],
  }, { id: () => 'po' });
  await writeProject(root, project);

  const first = await sweepInterruptedRuns(root, { now: () => '2026-09-15T09:00:00.000Z' });
  assert.equal(first.swept, 1, '只动真正孤立的那个');
  assert.deepEqual(first.touched, [{ id: 'po', runs: 1 }]);
  const after = await api0.get(root, 'po');
  const runs = after.scenes[0].outputs;
  const swept = runs.find(r => r.id === 'r-running');
  assert.equal(swept.status, 'failed');
  assert.equal(swept.finishedAt, '2026-09-15T09:00:00.000Z');
  assert.ok(swept.degradation.some(d => d.includes('生成被中断')), '要说清是"被中断"，不是含糊的"失败"');
  assert.equal(runs.find(r => r.id === 'r-done').status, 'succeeded', '已经收尾的运行一个都不能动');
  assert.equal(runs.find(r => r.id === 'r-odd').status, 'running');

  const second = await sweepInterruptedRuns(root, { now: () => '2026-09-15T10:00:00.000Z' });
  assert.equal(second.swept, 0, '幂等：再扫一次无事可做');
});

// 一键分镜段数不稳定：实测同一提示词请求 4 段，三次真实调用给 4 / 1 / 4 段。
// 段数明显不足时再要一次，并把"重试过"如实告诉用户。
test('分镜段数明显不足时自动重试一次，并如实上报重试', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await api0.create(root, { title: '重试' });
  const short = JSON.stringify({ scenes: [{ title: 's', beats: [{ kind: 'video', prompt: '只给一段', dialogue: '甲：一' }] }] });
  const full = JSON.stringify({ scenes: [1, 2, 3, 4].map(i => ({ title: `s${i}`, beats: [{ kind: 'video', prompt: `第 ${i} 段`, dialogue: `甲：${i}` }] })) });
  const prompts = [];
  const api = createStoryOrchestrator({
    root,
    directChat: async (model, prompt) => { prompts.push(prompt); return { text: prompts.length === 1 ? short : full } },
    getModelList: () => [],
  });
  const r = await api.storyboard(project.id, { idea: '试', count: 4 });
  assert.equal(prompts.length, 2, '第一次只给 1 段（要 4 段）→ 必须再要一次');
  assert.equal(r.beatCount, 4);
  assert.equal(r.attempts, 2);
  assert.equal(r.retried, true);
  assert.equal(r.firstBeatCount, 1);
  assert.match(prompts[1], /补充要求/, '第二次要把话说明白');
  assert.match(prompts[1], /上一次你只给了 1 段/);
  assert.equal(r.short, undefined, '给够了就不该有"还是不够"的提示');

  // 第一次就给够 → 不该多烧一次调用
  const prompts2 = [];
  const api2 = createStoryOrchestrator({ root, directChat: async (model, prompt) => { prompts2.push(prompt); return { text: full } }, getModelList: () => [] });
  const r2 = await api2.storyboard(project.id, { idea: '试', count: 4 });
  assert.equal(prompts2.length, 1);
  assert.equal(r2.attempts, 1);
  assert.equal(r2.retried, false);

  // 两次都不够：如实说"两次都只给了 N 段"，而不是假装完成
  const api3 = createStoryOrchestrator({ root, directChat: async () => ({ text: short }), getModelList: () => [] });
  const r3 = await api3.storyboard(project.id, { idea: '试', count: 6 });
  assert.equal(r3.beatCount, 1);
  assert.equal(r3.short, true);
  assert.match(r3.note, /两次都只给了 1 段/, '要如实说清模型没给够，让用户知道该再点一次');
});

test('runGeneration selects a capable image model when auto is requested', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-image-'));
  const project = createProject({ title: '图像故事', scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: '画面', references: [] }], outputs: [] }] }, { id: () => 'p2', now: () => '2026-09-12T08:00:00.000Z' });
  await writeProject(root, project);
  let used;
  const api = createStoryOrchestrator({ root, getDefaultModel: () => ({ provider: 'text', id: 'chat' }), getModelList: () => [{ provider: 'img', id: 'image-1', capabilities: { image: true } }], adapters: { image: { generate: async ({ model }) => { used = model; return { status: 'succeeded', output: { type: 'image', url: '/x' } }; } } }, clock: { id: () => 'r2', now: () => '2026-09-12T08:01:00.000Z' } });
  await api.runGeneration('p2', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'auto', id: 'auto' } });
  assert.deepEqual(used, { provider: 'img', id: 'image-1', capabilities: { image: true } });
});

// 段号是**产物**的一部分：重排分镜之后，历史产物卡上的"第 N 段"不能跟着变。
// 否则用户昨天导出的"第 3 段"今天就指向别的内容，产物就不再是历史了。
test('runGeneration stamps beatNo and sceneTitle at generation time, and reordering does not rewrite them', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-beatno-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '段号测试',
    scenes: [
      { id: 's1', index: 1, title: '第一场', summary: '', beats: [{ id: 'b1', kind: 'novel', prompt: '一', references: [] }, { id: 'b2', kind: 'novel', prompt: '二', references: [] }], outputs: [] },
      { id: 's2', index: 2, title: '第二场', summary: '', beats: [{ id: 'b3', kind: 'novel', prompt: '三', references: [] }], outputs: [] },
    ],
  }, { id: () => 'p3' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({ root, adapters: { novel: { generate: async () => ({ status: 'succeeded', output: { type: 'text', text: '正文' } }) } } });
  const result = await api.runGeneration('p3', { sceneId: 's2', beatId: 'b3', kind: 'novel' });
  assert.equal(result.run.beatNo, 3, '段号跨场景连续编号');
  assert.equal(result.run.sceneTitle, '第二场');

  // 把第二场挪到最前：当前顺序下 b3 变成第 1 段，但已生成的那次运行仍应写着第 3 段
  const stored = await api.get('p3');
  await api.patch('p3', { scenes: [stored.scenes[1], stored.scenes[0]] });
  const after = await api.get('p3');
  const run = after.scenes[0].outputs[0];
  assert.equal(run.beatNo, 3, '重排分镜不得改写已落盘产物的段号');
  assert.equal(run.sceneTitle, '第二场');
});

// 成片此前只存进产物库就返回，项目里没有任何记录——刷新页面链接就没了。
test('assembleFilm records the film in project.films and persists it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-film-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'clip.mp4'), 'not-really-mp4');
  const project = createProject({
    title: '成片测试',
    scenes: [{
      id: 's1', index: 1, title: '一', summary: '',
      beats: [{ id: 'b1', kind: 'video', prompt: '镜头', references: [] }],
      outputs: [{ id: 'r1', beatId: 'b1', status: 'succeeded', outputAssets: [{ id: 'a1', type: 'video', url: '/api/ws/file?path=clip.mp4' }] }],
    }],
  }, { id: () => 'p4' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({
    root,
    clock: { id: () => 'f1', now: () => '2026-09-15T10:00:00.000Z' },
    saveArtifactFromFile: async () => '/api/ws/file?path=films%2Ffilm-1.mp4',
  });
  const result = await api.assembleFilm('p4');
  assert.equal(result.film.clipCount, 1);
  assert.equal(result.film.method, 'copy');
  assert.deepEqual(result.film.beatIds, ['b1']);
  assert.equal(result.film.createdAt, '2026-09-15T10:00:00.000Z');
  assert.equal(result.project.films.length, 1, '返回值里带上了写回后的项目');
  // 真正的证据是**磁盘上**的项目；只改内存对象不算落地
  const reread = await api.get('p4');
  assert.equal(reread.films.length, 1);
  assert.equal(reread.films[0].url, '/api/ws/file?path=films%2Ffilm-1.mp4');
});

// ── 配色卡接进创作流（2026-09-16）────────────────────────────────────────
// 端到端走一遍预览：项目上选了配色卡，这一段的提示词里必须同时看到
// ①「## 配色方案」块（给模型看的）②③色调槽里的那套色（给上游画面模型看的）。
test('配色卡进提示词：预览里能同时看到配色块和色调槽', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-colorcard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '配色测试',
    colorCardId: 'morandi-violet-pink',
    scenes: [{ id: 's1', beats: [{ id: 'b1', kind: 'image', prompt: '她站在巷口回头', references: [] }] }],
  }, { id: () => 'p-color' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({ root });
  const r = await api.previewRun('p-color', { sceneId: 's1', beatId: 'b1', kind: 'image' });
  assert.match(r.context.prompt, /## 配色方案（莫兰迪高级灰 · 蓝紫粉）/, '模型要看到配色块');
  assert.match(r.context.prompt, /呈现蓝紫 #6453A1 过渡到浅粉 #FDDCE4/, '色调槽要落上这套色');
  assert.match(r.context.prompt, /不要荧光色与高饱和撞色/);

  // 没选配色的项目：一个字都不加（绝不替用户默认一套）
  const plain = createProject({
    title: '没配色',
    scenes: [{ id: 's1', beats: [{ id: 'b1', kind: 'image', prompt: '她站在巷口回头', references: [] }] }],
  }, { id: () => 'p-plain' });
  await writeProject(root, plain);
  const r2 = await createStoryOrchestrator({ root }).previewRun('p-plain', { sceneId: 's1', beatId: 'b1', kind: 'image' });
  assert.doesNotMatch(r2.context.prompt, /配色方案/);
  assert.doesNotMatch(r2.context.prompt, /#6453A1/);
});

// 一键分镜那一刻就要带上配色：等生成时再覆盖 shot.tone 只是打补丁，分镜里的画面描述已经写歪了
test('一键分镜：项目选了配色卡，分镜提示词里带上配色', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-storyboard-color-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({ title: '配色分镜', colorCardId: 'morandi-pink-rice' }, { id: () => 'p-sb-color' });
  await writeProject(root, project);
  const prompts = [];
  const api = createStoryOrchestrator({
    root,
    directChat: async (model, prompt) => { prompts.push(prompt); return { text: JSON.stringify({ scenes: [{ title: 's', beats: [{ kind: 'video', prompt: '开场', dialogue: '甲：一' }, { kind: 'video', prompt: '第二段', dialogue: '甲：二' }] }] }) } },
    getModelList: () => [],
  });
  await api.storyboard('p-sb-color', { idea: '试', count: 2 });
  assert.match(prompts[0], /【本片配色】莫兰迪高级灰 · 粉红加米/);
  assert.match(prompts[0], /#E16668/);
});

// 一次生成可以临时换配色（input.colorCard），但项目上那份不能被悄悄改掉
test('配色卡：这一次显式传的优先，且不改项目的选择', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-colorcard2-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '覆盖测试',
    colorCardId: 'morandi-violet-pink',
    scenes: [{ id: 's1', beats: [{ id: 'b1', kind: 'image', prompt: '巷口', references: [] }] }],
  }, { id: () => 'p-override' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({ root });
  const r = await api.previewRun('p-override', { sceneId: 's1', beatId: 'b1', kind: 'image', colorCard: 'morandi-pink-rice' });
  assert.match(r.context.prompt, /粉红加米/);
  assert.doesNotMatch(r.context.prompt, /蓝紫粉/);
  assert.equal((await api.get('p-override')).colorCardId, 'morandi-violet-pink', '一次覆盖不该改项目上的选择');
});
