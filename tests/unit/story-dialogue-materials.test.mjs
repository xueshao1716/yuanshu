// 连续创作「台词创作」与「别处素材能挂进来」契约（2026-09-15）
//
// 两个真实缺口：
//  1) 三个提示词（compileStoryPrompt / buildStoryboardPrompt / buildStoryAssistPrompt）里
//     **一个"对话"字都没有**，分镜提示词还明确只要求"动作、构图、镜头、光线"——
//     出来的是一串漂亮的画面说明，一句人话没有，戏不成戏。
//  2) 连续创作能用的素材只有「角色定妆照」（因为它是设定里的一个字段）。
//     AI 绘画出的图、视频工坊出的片、小说工坊写的正文就在同一个工作区里，却一个字都进不来。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileStoryPrompt, dialogueBlock, materialBlock } from '../../engine/story/prompts.mjs';
import { buildStoryboardPrompt, buildStoryAssistPrompt, parseStoryboard, parseStoryAssist } from '../../engine/story/assist.mjs';
import { normalizeBeatInputs, mergeBeatContext, createProject, writeProject } from '../../engine/story/store.mjs';
import { createStoryOrchestrator } from '../../engine/story/orchestrator.mjs';

// ─────────── 台词 ───────────

test('台词单独成块，且不会混进画面提示词里', () => {
  const beat = { id: 'b1', kind: 'novel', prompt: '站台空镜', dialogue: '阿宁：车怎么还不来\n老周：它不来了。' };
  const novel = compileStoryPrompt({ scene: { title: '站台' }, beat, inherited: {} }).text;
  assert.match(novel, /## 本段台词/, '文字段落必须把台词交给模型，并明确要求按台词写成戏');
  assert.match(novel, /阿宁：车怎么还不来/);

  // 画面：台词写进画面描述会被生图模型当内容画出来，或者把真正的视觉指令稀释掉
  assert.equal(dialogueBlock(beat, 'image'), '', 'image 段不得把台词塞进生图提示词');
  assert.doesNotMatch(compileStoryPrompt({ scene: {}, beat: { ...beat, kind: 'image' }, inherited: {} }).text, /车怎么还不来/);

  const video = compileStoryPrompt({ scene: {}, beat: { ...beat, kind: 'video' }, inherited: {} }).text;
  assert.match(video, /本段台词/, '视频段落要带台词（后续配音/口播要念的就是它）');
  assert.match(video, /不要当成画面内容去画/, '要讲明白台词不是画面指令');
});

test('没有台词就不生成空块（别给模型灌一段没有内容的标题）', () => {
  assert.equal(dialogueBlock({ id: 'b', kind: 'novel', prompt: 'x' }, 'novel'), '');
  assert.equal(dialogueBlock({ id: 'b', kind: 'novel', dialogue: '   ' }, 'novel'), '');
  assert.doesNotMatch(compileStoryPrompt({ scene: {}, beat: { id: 'b', kind: 'novel', prompt: 'x' }, inherited: {} }).text, /本段台词/);
});

test('分镜提示词必须要求台词，并且样例里带 dialogue 字段', () => {
  const p = buildStoryboardPrompt({ title: 'T', logline: 'L', idea: 'I', count: 4 });
  assert.match(p, /重视对话创作/);
  assert.match(p, /台词/, '不写进提示词，模型就不会给台词');
  assert.match(p, /"dialogue"/, 'JSON 样例里没有这个键，模型基本不会自己加上');
  assert.match(p, /禁止"两人交谈了几句"/, '要明确禁止把对白写成概述');
  const assist = buildStoryAssistPrompt({ title: 'T', idea: 'I' });
  assert.match(assist, /重视对话/);
  assert.match(assist, /"dialogue"/);
});

test('台词字段的解析要宽容：dialogue / 台词 / 对白 / 数组 / {name,text} 都收', () => {
  const one = parseStoryboard(JSON.stringify({ scenes: [{ title: 's', beats: [{ kind: 'video', prompt: '画面', dialogue: '甲：走' }] }] }));
  assert.equal(one.scenes[0].beats[0].dialogue, '甲：走');
  const cn = parseStoryboard('{"scenes":[{"beats":[{"prompt":"画面","台词":"乙：站住"}]}]}');
  assert.equal(cn.scenes[0].beats[0].dialogue, '乙：站住');
  const arr = parseStoryboard('{"scenes":[{"beats":[{"prompt":"画面","dialogue":["甲：一","乙：二"]}]}]}');
  assert.equal(arr.scenes[0].beats[0].dialogue, '甲：一\n乙：二');
  const obj = parseStoryboard('{"scenes":[{"beats":[{"prompt":"画面","dialogue":[{"name":"甲","text":"三"}]}]}]}');
  assert.equal(obj.scenes[0].beats[0].dialogue, '甲：三');
  // 真实模型常把台词键写成 line / lines / script
  assert.equal(parseStoryboard('{"scenes":[{"beats":[{"prompt":"p","line":"丙：四"}]}]}').scenes[0].beats[0].dialogue, '丙：四');
  assert.equal(parseStoryAssist('{"beat":{"kind":"novel","prompt":"p","dialogue":"丁：五"}}').beat.dialogue, '丁：五');
});

test('只有台词、没有画面描述的段不能被丢掉——那是编剧刚写好的对白', () => {
  const r = parseStoryboard('{"scenes":[{"title":"s","beats":[{"kind":"novel","dialogue":"阿宁：我不走了。"}]}]}');
  assert.equal(r.beatCount, 1);
  assert.equal(r.scenes[0].beats[0].prompt, '', '画面可以后补');
  assert.match(r.scenes[0].beats[0].dialogue, /我不走了/);
});

// ─────────── 素材挂载 ───────────

test('素材形状要清洗：类型非法/图片缺地址/空文本一律丢掉，文本截断到 4000 字', () => {
  const out = normalizeBeatInputs([
    { id: 'a', type: 'image', url: '/api/ws/file?path=a.png', name: 'a.png' },
    { id: 'b', type: 'image' },                        // 没有地址 → 丢
    { id: 'c', type: 'text', text: 'x'.repeat(9000) }, // 超长 → 截断
    { id: 'd', type: 'exe', url: '/x' },               // 类型非法 → 丢
    { id: 'e', type: 'video', url: '/api/ws/file?path=v.mp4' },
    null,
  ]);
  assert.deepEqual(out.map(i => i.id), ['a', 'c', 'e']);
  assert.equal(out[1].text.length, 4000);
  assert.equal(out[2].type, 'video');
  assert.deepEqual(normalizeBeatInputs('not-an-array'), []);
});

test('素材沿继承链累积：续写的段落看得见上一段挂的东西', () => {
  const project = createProject({
    title: 't',
    scenes: [{
      id: 's1', index: 1, title: '一', summary: '',
      beats: [
        { id: 'b1', kind: 'image', prompt: '一', references: [], inputs: [{ id: 'i1', type: 'image', url: '/api/ws/file?path=p.png', name: 'p.png' }] },
        { id: 'b2', kind: 'image', prompt: '二', references: [], inheritFromBeatId: 'b1', inputs: [{ id: 'i2', type: 'text', text: '阿宁：别走。', name: '第一章' }] },
      ],
      outputs: [],
    }],
  }, { id: () => 'p1' });
  const scene = project.scenes[0];
  const ctx = mergeBeatContext(project, scene, scene.beats[1]);
  assert.deepEqual(ctx.materials.map(m => m.id), ['i1', 'i2'], '继承链上的素材要一起进来，且顺序是先祖先后自己');
  // 只挂在自己身上、没有继承的段落不该看到别人的素材
  const lone = mergeBeatContext(project, scene, scene.beats[0]);
  assert.deepEqual(lone.materials.map(m => m.id), ['i1']);
});

test('文本素材的内容要进提示词（截断），图/视频素材只报"有什么"', () => {
  const block = materialBlock([
    { type: 'text', name: '第一章', text: '阿宁：车不来了。' },
    { type: 'image', name: '参考.png', url: '/x.png' },
    { type: 'video', name: '片段.mp4', url: '/v.mp4' },
  ]);
  assert.match(block, /阿宁：车不来了。/);
  assert.match(block, /画面素材：参考\.png/);
  assert.match(block, /视频素材：片段\.mp4/);
  assert.equal(materialBlock([]), '');
  assert.equal(materialBlock(undefined), '');
});

test('挂载的图/视频素材真的接到适配器：图走参考图、视频走 videos[]、文本记进产物历史', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-mat-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const img = path.join(root, '生成物', '图片', 'ref.png');
  await fs.promises.mkdir(path.dirname(img), { recursive: true });
  await fs.promises.writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 7]));
  const imgUrl = `/api/ws/file?path=${encodeURIComponent(path.relative(root, img))}`;
  const clip = path.join(root, '生成物', '视频', 'a.mp4');
  await fs.promises.mkdir(path.dirname(clip), { recursive: true });
  await fs.promises.writeFile(clip, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
  const clipUrl = `/api/ws/file?path=${encodeURIComponent(path.relative(root, clip))}`;

  const project = createProject({
    title: '素材',
    scenes: [{
      id: 's1', index: 1, title: '一', summary: '',
      beats: [{
        id: 'b1', kind: 'video', prompt: '站台', references: [],
        inputs: [
          { id: 'i-img', type: 'image', url: imgUrl, name: 'ref.png' },
          { id: 'i-vid', type: 'video', url: clipUrl, name: 'a.mp4' },
          { id: 'i-txt', type: 'text', text: '阿宁：车不来了。', name: '第一章' },
        ],
      }],
      outputs: [],
    }],
  }, { id: () => 'pm' });
  await writeProject(root, project);

  let seen;
  const api = createStoryOrchestrator({
    root,
    adapters: { video: { generate: async (args) => { seen = args; return { status: 'succeeded', output: { type: 'video', url: '/v.mp4' } } } } },
    getModelList: () => [{ provider: 'agnes', id: 'agnes-video-2.5-flash', capabilities: { video: true, reference: true, keyframe: true, seed: true } }],
  });
  const result = await api.runGeneration('pm', { sceneId: 's1', beatId: 'b1', kind: 'video', model: { provider: 'agnes', id: 'agnes-video-2.5-flash' } });

  assert.equal(seen.referenceImages.length, 1, '图的素材要变成参考图');
  assert.match(seen.referenceImages[0], /^data:image\/png;base64,/, '而且要是上游认的形式（元枢地址会被拒，见 media-inline）');
  assert.match(String(seen.params.videos?.[0] || ''), /^data:video\/mp4;base64,/, '视频素材走 videos[]');
  assert.match(seen.prompt, /阿宁：车不来了。/, '文本素材作为创作依据进提示词');
  // 产物历史记的是原始引用，不是内联后的 base64（否则项目 JSON 会被撑爆）
  assert.ok(result.run.referenceImages.includes(imgUrl));
  assert.ok(result.run.inputAssets.some(a => a.id === 'i-img' && a.url === imgUrl));
  assert.ok(result.run.inputAssets.some(a => a.id === 'i-txt' && a.role === 'source-text'));
  assert.ok(JSON.stringify(await api.get('pm')).length < 20000);
});

test('画面（图生图）只有一张入口：用户显式挂的素材优先，且顺序与真实能力对齐', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-mat2-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const mk = async (rel, bytes) => {
    const p = path.join(root, rel);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, Buffer.from(bytes));
    return `/api/ws/file?path=${encodeURIComponent(path.relative(root, p))}`;
  };
  const portrait = await mk('生成物/图片/portrait.png', [0x89, 0x50, 0x4e, 0x47, 1]);
  const material = await mk('生成物/图片/mood.png', [0x89, 0x50, 0x4e, 0x47, 2]);

  const project = createProject({
    title: '顺序',
    bible: { characters: [{ id: 'c1', name: '阿宁', refImage: portrait }] },
    scenes: [{
      id: 's1', index: 1, title: '一', summary: '',
      beats: [{ id: 'b1', kind: 'image', prompt: '阿宁站在站台', references: [], inputs: [{ id: 'm1', type: 'image', url: material, name: 'mood.png' }] }],
      outputs: [],
    }],
  }, { id: () => 'po' });
  await writeProject(root, project);

  let seen;
  const api = createStoryOrchestrator({
    root,
    adapters: { image: { generate: async (args) => { seen = args; return { status: 'succeeded', output: { type: 'image', url: '/i.png' } } } } },
    getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: { image: true, reference: true, seed: true } }],
  });
  await api.runGeneration('po', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' } });
  assert.equal(seen.referenceImages.length, 1, '图生图只有一张入口，就必须只送一张');
  const sent = Buffer.from(seen.referenceImages[0].split(',')[1], 'base64');
  assert.equal(sent[sent.length - 1], 2, '送的应该是用户显式挂的素材（挂了却不生效是最坏的静默失败）');
});

test('素材地址解析不到时如实降级，不硬塞一个坏地址给上游', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yuanshu-story-mat3-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '坏素材',
    scenes: [{
      id: 's1', index: 1, title: '一', summary: '',
      beats: [{ id: 'b1', kind: 'image', prompt: 'x', references: [], inputs: [{ id: 'm1', type: 'image', url: '/api/ws/file?path=%E6%B2%A1%E6%9C%89.png', name: '没有.png' }] }],
      outputs: [],
    }],
  }, { id: () => 'px' });
  await writeProject(root, project);
  let seen = 'never';
  const api = createStoryOrchestrator({
    root,
    adapters: { image: { generate: async (a) => { seen = a.referenceImages; return { status: 'succeeded', output: { type: 'image', url: '/i.png' } } } } },
    getModelList: () => [{ provider: 'p', id: 'img-1', capabilities: { image: true, reference: true, seed: true } }],
  });
  const r = await api.runGeneration('px', { sceneId: 's1', beatId: 'b1', kind: 'image', model: { provider: 'p', id: 'img-1' } });
  assert.deepEqual(seen, []);
  assert.ok(r.run.degradation.some(d => d.includes('参考图未上送')), '拿不到素材要说话，不能装作没挂过');
  assert.equal(r.run.status, 'degraded');
});
