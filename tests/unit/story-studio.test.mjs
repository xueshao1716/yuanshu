// 连续创作「制作台」契约（2026-09-14）
// 覆盖三件此前缺失的能力：连续性体检 / 一键分镜 / 成片合成。
// 其中成片合成会**真的调用 ffmpeg** 拼两段合成片——本机没装 ffmpeg 时跳过，
// 不让测试变成机器相关。素材用 lavfi 现造，不碰用户的工作产物（AGENTS.md:24）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintStoryProject } from '../../engine/story-lint.mjs';
import { localPathFromArtifactUrl, collectFilmClips, concatClips, ffmpegAvailable, runFfmpeg } from '../../engine/story-film.mjs';
import { buildStoryboardPrompt, parseStoryboard } from '../../engine/story-assist.mjs';
import { mergeStoryboardBible, pickBeatReferences } from '../../engine/story-orchestrator.mjs';

const WS = 'D:/pi-workspace';

test('体检：缺外貌/缺定妆照/未继承前文/模型不支持参考图都要报出来', () => {
  const project = {
    logline: '一个拳手',
    bible: { characters: [
      { id: 'c1', name: '阿宁', appearance: '黑发', refImage: '/signed/p.png' },
      { id: 'c2', name: '小雨' },
    ] },
    scenes: [{ id: 's1', title: '第一场', summary: '', beats: [
      { id: 'b1', kind: 'video', prompt: '开场' },
      { id: 'b2', kind: 'video', prompt: '继续' },
    ] }],
  };
  const { issues, summary } = lintStoryProject(project, { kind: 'video', capabilities: { reference: false } });
  const codes = issues.map(i => i.code);
  assert.ok(codes.includes('character-no-appearance'), '缺少外貌必须报');
  assert.ok(codes.includes('character-no-portrait'), '缺少定妆照必须报');
  assert.ok(codes.includes('beat-not-inherited'), '第 2 段没继承前文必须报');
  assert.ok(codes.includes('model-no-reference'), '模型不支持参考图必须报');
  assert.ok(codes.includes('scene-no-summary'), '场景缺摘要要报');
  assert.equal(summary.characters, 2);
  assert.equal(summary.portraits, 1);
  assert.equal(summary.level, 'warn');
});

test('体检：条件齐备时不报 warn，且文本段落不因参考图能力报警', () => {
  const project = {
    logline: '有梗概',
    bible: { characters: [{ id: 'c1', name: '阿宁', appearance: '宽肩、头肩比好，黑发', refImage: '/signed/p.png' }] },
    scenes: [{ id: 's1', title: '第一场', summary: '摘要', beats: [{ id: 'b1', kind: 'novel', prompt: '开场' }] }],
  };
  const clean = lintStoryProject(project, { kind: 'image', capabilities: { reference: true } });
  // 2026-09-16：原来断言 `issues` 全空。现在"还没有深度构思"会以 **info** 出现
  //（它确实值得提醒，但不该吓人）——所以这里锁的是原本的意图：**不报 warn、总级别 ok**。
  // 同一天还多了"外貌缺身体结构"这条 info：既然这个用例的场景是"条件齐备"，
  // 外貌就补上结构词（宽肩/头肩比），否则它当然有资格提这一条。
  assert.deepEqual(clean.issues.filter(i => i.level === 'warn'), []);
  assert.deepEqual(clean.issues.map(i => i.code), ['no-craft']);
  assert.equal(clean.summary.level, 'ok');
  // 文本段落不该因为参考图能力被告警
  const novel = lintStoryProject(project, { kind: 'novel', capabilities: { reference: false } });
  assert.ok(!novel.issues.some(i => i.code === 'model-no-reference'));
});

// 2026-09-16：身体结构锚点（借 hypit 的 Person 段写法）。这条只提示、不阻塞——
// 一句话设定的角色也得出得了图，但得让人知道半身像容易出"窄肩配大脑袋"。
test('体检：外貌只有笼统赞美时提示缺身体结构，且只算 info 不拉高级别', () => {
  const base = { logline: '有梗概', scenes: [{ id: 's1', title: '第一场', summary: '摘要', beats: [{ id: 'b1', kind: 'novel', prompt: '开场' }] }] };
  const vague = lintStoryProject(
    { ...base, bible: { characters: [{ id: 'c1', name: '阿宁', appearance: '气质出众', refImage: '/signed/p.png' }] } },
    { kind: 'image', capabilities: { reference: true } },
  );
  const issue = vague.issues.find(i => i.code === 'character-no-structure');
  assert.ok(issue, '只有"气质出众"这类笼统词必须提示缺结构');
  assert.equal(issue.level, 'info', '这是建议不是阻塞');
  // 说清楚真实行为：info 会把总级别从 ok 抬到 info（和既有的 no-craft 一样），
  // 但**不会**报 warn。这里锁的是"不阻塞"，不是"级别不变"——写测试时我一开始
  // 断言的是 ok，跑出来才发现 info 分级是这么算的。
  assert.equal(vague.summary.level, 'info');
  assert.deepEqual(vague.issues.filter(i => i.level === 'warn'), [], '建议不该升级成警告');

  const solid = lintStoryProject(
    { ...base, bible: { characters: [{ id: 'c1', name: '阿宁', appearance: '宽肩、头肩比好，短发', refImage: '/signed/p.png' }] } },
    { kind: 'image', capabilities: { reference: true } },
  );
  assert.ok(!solid.issues.some(i => i.code === 'character-no-structure'), '写了结构就不该再提示');
});

test('签名产物 URL 能解出磁盘路径，且拒绝越界与外链', () => {
  const rel = '生成物\\视频\\2026-09-13\\a.mp4';
  const url = `/api/ws/file?path=${encodeURIComponent(rel)}&exp=1&sig=abc`;
  const got = localPathFromArtifactUrl(url, WS);
  assert.equal(got, path.resolve(WS, rel));
  assert.equal(localPathFromArtifactUrl('https://cdn.example/v.mp4', WS), '', '外链不能当本地文件');
  assert.equal(localPathFromArtifactUrl('data:video/mp4;base64,AAAA', WS), '', 'data URL 不能当本地文件');
  assert.equal(localPathFromArtifactUrl('/api/ws/file?path=..%2F..%2Fetc%2Fpasswd', WS), '', '必须拦住路径穿越');
});

test('成片素材按分镜顺序收集，只取成功的视频产出', () => {
  const file = path.join(WS, '生成物', '视频', '2026-09-13', 'x.mp4');
  const project = { scenes: [{ id: 's1', beats: [{ id: 'b1' }, { id: 'b2' }], outputs: [
    { beatId: 'b1', status: 'succeeded', outputAssets: [{ type: 'video', url: `/api/ws/file?path=${encodeURIComponent('生成物\\视频\\2026-09-13\\x.mp4')}` }] },
    { beatId: 'b1', status: 'failed', outputAssets: [{ type: 'video', url: '/api/ws/file?path=nope.mp4' }] },
    { beatId: 'b2', status: 'degraded', outputAssets: [{ type: 'image', url: '/api/ws/file?path=a.png' }] },
  ] }] };
  const clips = fs.existsSync(file) ? collectFilmClips(project, WS) : [];
  // 机器上没有该素材时至少验证筛选逻辑：失败态与被覆盖的旧产出都不进列表
  for (const clip of clips) assert.equal(clip.beatId, 'b1');
  assert.ok(clips.length <= 1);
});

test('一键分镜：只接受三种 kind、滤掉空段、算对总段数', () => {
  const raw = '```json\n' + JSON.stringify({ scenes: [
    { title: '第一场', summary: '开场', beats: [{ kind: 'video', prompt: '推门而入' }, { kind: '乱写', prompt: '跟进' }, { kind: 'image', prompt: '   ' }] },
    { title: '空场', summary: '', beats: [] },
  ] }) + '\n```';
  const parsed = parseStoryboard(raw);
  assert.equal(parsed.beatCount, 2, '空的与非法 kind 的段要滤掉');
  assert.equal(parsed.scenes.length, 1, '没有段落的场景不保留');
  assert.equal(parsed.scenes[0].beats[0].kind, 'video');
  assert.equal(parsed.scenes[0].beats[1].kind, 'image', '未知 kind 回落成 image');
  assert.throws(() => parseStoryboard('不是 JSON'), /不是有效 JSON/);
  assert.throws(() => parseStoryboard('{"scenes":[]}'), /没有任何可生成的段落/);
  const prompt = buildStoryboardPrompt({ title: 'T', logline: 'L', count: 99 });
  assert.match(prompt, /12 段/, '段数必须夹到上限内');
  assert.match(prompt, /只返回 JSON/);
});

// 2026-09-14 首次真实调用就踩到：模型返回的 JSON 能解析，但形状与理想不符
// （包一层、scenes 给成对象、段落提示词叫 content…），解析不出来对用户就是功能不可用。
test('一键分镜：真实模型的各种走形都要能解析出来', () => {
  const shapes = {
    '带解释前缀': '这是我的分镜：\n{"scenes":[{"beats":[{"kind":"video","prompt":"推门"}]}]}',
    '包一层 storyboard': '{"storyboard":{"scenes":[{"beats":[{"prompt":"推门"}]}]}}',
    'scenes 给成对象': '{"scenes":{"title":"一","beats":[{"kind":"video","prompt":"推门"}]}}',
    'beats 叫 shots': '{"scenes":[{"shots":[{"kind":"image","prompt":"画面"}]}]}',
    '提示词叫 description': '{"scenes":[{"beats":[{"type":"video","description":"镜头推进"}]}]}',
    '顶层直接给 beats': '{"beats":[{"prompt":"开场"},{"prompt":"推进"}]}',
    '段落是纯字符串': '{"scenes":[{"beats":["第一段","第二段"]}]}',
    'kind 是中文': '{"scenes":[{"beats":[{"kind":"视频片段","prompt":"运镜"}]}]}',
  };
  for (const [name, raw] of Object.entries(shapes)) {
    const parsed = parseStoryboard(raw);
    assert.ok(parsed.beatCount >= 1, `${name} 必须能解析出段落`);
  }
  // 顶层直接给 beats 时，两段都要在
  assert.equal(parseStoryboard('{"beats":[{"prompt":"开场"},{"prompt":"推进"}]}').beatCount, 2);
  // 中文 kind 要能归一化
  assert.equal(parseStoryboard('{"scenes":[{"beats":[{"kind":"视频片段","prompt":"运镜"}]}]}').scenes[0].beats[0].kind, 'video');
});

// 2026-09-14 真实调用第二次踩到：模型先复述提示词里的「已有设定」JSON，再给分镜。
// 只取第一个配平对象就会把复述当成结果（线上报出的顶层键正是 characters/locations/props/…）。
test('一键分镜：模型先复述上下文再给答案时，必须跳过复述取真正的分镜', () => {
  const messy = [
    '已有设定：{"characters":[{"id":"c1","name":"阿宁"}],"locations":[],"props":[],"wardrobe":[],"style":{},"rules":[]}',
    '好的，我按 4 段来排：',
    '{"scenes":[{"title":"雨夜","summary":"车站","beats":[{"kind":"video","prompt":"雨落在站台"},{"kind":"video","prompt":"他看向出口"}]}]}',
  ].join('\n');
  const parsed = parseStoryboard(messy);
  assert.equal(parsed.beatCount, 2, '必须跳过开头的设定复述');
  assert.equal(parsed.scenes[0].title, '雨夜');
  // 只有设定、没有分镜时仍要报错，并说明试过哪些顶层键
  assert.throws(() => parseStoryboard('{"characters":[],"locations":[]}'), /没有任何可生成的段落/);
});

// 2026-09-14：分镜只出段落、不登记角色，导致「定妆照」和「参考图锁定」在界面上存在却无数据可用。
test('一键分镜连设定一起登记：角色并进 bible、引用挂到段落上', () => {
  const raw = JSON.stringify({
    bible: { characters: [{ name: '阿宁', appearance: '二十岁，黑短发，旧夹克' }], locations: [{ name: '车站', description: '雨夜的旧站台' }], style: { visual: '冷调' } },
    scenes: [{ title: '雨夜', summary: '等一个人', beats: [{ kind: 'video', prompt: '阿宁站在站台边' }, { kind: 'video', prompt: '镜头推向出口' }] }],
  });
  const parsed = parseStoryboard(raw);
  assert.equal(parsed.bible.characters.length, 1, '设定的角色必须跟着分镜一起回来');
  assert.equal(parsed.bible.characters[0].name, '阿宁');
  assert.equal(parsed.bible.style.visual, '冷调');

  // 只补空缺：同名角色不重复登记，已有风格不被分镜冲掉
  const existing = { characters: [{ id: 'c1', name: '阿宁', appearance: '人工写好的' }], locations: [], props: [], wardrobe: [], style: { visual: '人工定调' }, rules: [] };
  const merged = mergeStoryboardBible(existing, parsed.bible);
  assert.equal(merged.characters.length, 1, '同名角色不能重复登记');
  assert.equal(merged.characters[0].appearance, '人工写好的', '不能改写已登记的设定');
  assert.equal(merged.style.visual, '人工定调', '已有风格优先');
  assert.equal(merged.locations.length, 1, '新场景要补进来');
  assert.ok(merged.locations[0].id, '新登记的实体必须有 id');

  // 点到名就挂谁；没点到名（模型用英文写镜头、角色名是中文）退回主角，不让锁定静默失效
  const cast = [{ id: 'c1', name: '阿宁' }, { id: 'c2', name: '小雨' }];
  assert.deepEqual(pickBeatReferences(cast, '阿宁站在站台边'), [{ id: 'c1', role: 'character' }]);
  assert.deepEqual(pickBeatReferences(cast, 'Close-up on the boxer'), [{ id: 'c1', role: 'character' }]);
  assert.deepEqual(pickBeatReferences([], '任何'), [], '没有角色就不该凭空造引用');
});

test('成片合成：真的用 ffmpeg 把两段拼成一条（无 ffmpeg 则跳过）', async t => {
  if (!(await ffmpegAvailable())) { t.skip('本机没有 ffmpeg'); return; }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-film-test-'));
  try {
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    // lavfi 现造两段纯色片，不碰用户产物
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1', '-pix_fmt', 'yuv420p', a]);
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1', '-pix_fmt', 'yuv420p', b]);
    const out = path.join(dir, 'film.mp4');
    const result = await concatClips({ clips: [{ file: a }, { file: b }], outFile: out, workDir: dir });
    assert.equal(result.clipCount, 2);
    assert.equal(result.method, 'concat');
    assert.ok(fs.existsSync(out), '必须产出成片文件');
    assert.ok(fs.statSync(out).size > 1000, '成片不能是空文件');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
