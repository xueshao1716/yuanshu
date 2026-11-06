// 分集（集）契约：短剧/系列以"集"为组织单位。
//
// 锁三条意图，都是"顺手做错就不可挽回"的地方：
// - 允许"未分集"（单集短片照旧能用），未分组的场永远排在最后而不是被塞进某一集；
// - 删集**只解绑不删场**——删一个集把内容一起带走是最不能接受的顺手；
// - 一集一条场次/段落/进度账（界面与批量生成共用同一个数，不各算一遍）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEpisodes, createEpisode, cleanEpisodeTitle, nextEpisodeNo, groupScenesByEpisode, episodeOf, episodeStats, assignSceneToEpisode, removeEpisode, renumberEpisodes, EPISODE_MAX } from '../../engine/story/episodes.mjs';
import { projectToElements, renderScript } from '../../engine/story/screenplay.mjs';

const project = () => ({
  title: '钥匙',
  episodes: [
    { id: 'ep1', no: 1, title: '站台', summary: '相遇' },
    { id: 'ep2', no: 2, title: '钥匙', summary: '悬念' },
  ],
  scenes: [
    { id: 's1', index: 1, episodeId: 'ep1', title: '夜站台', summary: '', beats: [{ id: 'b1', kind: 'novel', prompt: '阿宁下车', dialogue: '阿宁：你为什么不走？' }], outputs: [{ id: 'r1', beatId: 'b1', status: 'succeeded', outputAssets: [{ id: 'a1', type: 'text', text: '正文' }] }] },
    { id: 's2', index: 2, episodeId: 'ep2', title: '旧楼道', summary: '', beats: [{ id: 'b2', kind: 'video', prompt: '钥匙插进锁孔' }], outputs: [{ id: 'r2', beatId: 'b2', status: 'failed', degradation: ['上游 500'] }] },
    { id: 's3', index: 3, title: '未归的场', summary: '', beats: [{ id: 'b3', kind: 'image', prompt: '空镜头' }], outputs: [] },
  ],
});

test('集的规范：编号排序、标题兜底、上限、目标时长是真数才算', () => {
  const list = normalizeEpisodes([
    { id: 'b', no: 5, title: '  ' },
    { id: 'a', no: 2, title: '二', targetSeconds: '0' },
    999,
  ]);
  assert.deepEqual(list.map(e => e.id), ['a', 'b']);
  assert.equal(list[0].title, '二');
  assert.equal(list[0].targetSeconds, undefined, '0 秒不是目标时长');
  assert.equal(list[1].title, '第 5 集', '没标题就用编号兜底');
  assert.equal(normalizeEpisodes(new Array(EPISODE_MAX + 5).fill({ no: 1 })).length, EPISODE_MAX);
  assert.equal(nextEpisodeNo([{ no: 3 }, { no: 7 }]), 8);
});

test('建集：不传编号就接着最后一个编号排，标题自动叫「第 N 集」', () => {
  const ep = createEpisode({ summary: '  相遇与钩子  ' }, { id: () => 'ep9', now: () => 'T' });
  assert.equal(ep.id, 'ep9');
  assert.equal(ep.no, 1);
  assert.equal(ep.title, '第 1 集');
  assert.equal(ep.summary, '相遇与钩子');
  const ep2 = createEpisode({ targetSeconds: 45, episodes: [{ id: 'x', no: 4 }] }, { id: () => 'ep10' });
  assert.equal(ep2.no, 5);
  assert.equal(ep2.targetSeconds, 45);
});

test('标题里写过的「第 N 集」不重复存：集号是独立字段，界面和导出都会再加一遍', () => {
  // 真机上出现过「第 1 集 · 第 1 集 · 站台」——标题里带了集号，前缀又加了一次
  assert.equal(createEpisode({ title: '第 1 集 · 站台' }).title, '站台');
  assert.equal(createEpisode({ title: '第12集：钥匙' }).title, '钥匙');
  assert.equal(createEpisode({ title: '第 3 集' }).title, '第 1 集', '只剩集号时退回按编号生成的标题——集号以 no 字段为准');
  assert.equal(normalizeEpisodes([{ id: 'a', no: 2, title: '第 2 集 - 旧楼道' }])[0].title, '旧楼道');
  assert.equal(cleanEpisodeTitle('第十道雷与躺平协议', 1), '第十道雷与躺平协议', '正常标题一个字都不动');
});

test('分组：按集归组，"未分集"永远排在最后，而不是被塞进某一集', () => {
  const groups = groupScenesByEpisode(project());
  assert.deepEqual(groups.map(g => g.episode?.id || null), ['ep1', 'ep2', null]);
  assert.deepEqual(groups[2].scenes.map(s => s.id), ['s3']);
  // 指向不存在的集 = 未分集（集被删过、或数据手改过），不能凭空多出一个空组
  const orphan = groupScenesByEpisode({ ...project(), scenes: [{ id: 's9', episodeId: '没了', beats: [] }] });
  assert.deepEqual(orphan.map(g => g.episode?.id || null), [null]);
});

test('分集账：一集的场/段/已出/失败各算清楚，界面与批量生成共用这一个数', () => {
  const st = episodeStats(project(), 'ep1');
  assert.equal(st.scenes, 1);
  assert.equal(st.beats, 1);
  assert.equal(st.withOutput, 1);
  assert.equal(st.pending, 0);
  const bad = episodeStats(project(), 'ep2');
  assert.equal(bad.failed, 1);
  assert.equal(bad.pending, 1);
  assert.equal(bad.withOutput, 0);
});

test('指派：场能归集也能放回未分集；指到不存在的集或改不存在的场必须报错', () => {
  const p = project();
  const moved = assignSceneToEpisode(p, 's3', 'ep1');
  assert.equal(moved.scenes.find(s => s.id === 's3').episodeId, 'ep1');
  const back = assignSceneToEpisode(moved, 's3', '');
  assert.equal('episodeId' in back.scenes.find(s => s.id === 's3'), false, '放回未分集要把字段去掉，不是留个空串');
  assert.throws(() => assignSceneToEpisode(p, 's3', '不存在'), /这一集不存在/);
  assert.throws(() => assignSceneToEpisode(p, '不存在', 'ep1'), /这一场不存在/);
  assert.equal(p.scenes.find(s => s.id === 's3').episodeId, undefined, '指派不该原地改原对象');
});

test('删集只解绑不删场：内容一个都不能丢', () => {
  const p = project();
  const next = removeEpisode(p, 'ep2');
  assert.deepEqual(next.episodes.map(e => e.id), ['ep1']);
  assert.equal(next.scenes.length, 3, '场数不变');
  assert.equal(next.scenes.find(s => s.id === 's2').episodeId, undefined);
  assert.deepEqual(next.scenes.find(s => s.id === 's2').beats.map(b => b.id), ['b2'], '段落也都在');
  assert.equal(next.unassigned, 2);
  assert.throws(() => removeEpisode(p, '没了'), /这一集不存在/);
});

test('重排编号：删掉中间一集后，「第 N 集」重新连续', () => {
  const p = { ...project(), episodes: [{ id: 'a', no: 1 }, { id: 'b', no: 4 }, { id: 'c', no: 9 }] };
  assert.deepEqual(renumberEpisodes(p).episodes.map(e => e.no), [1, 2, 3]);
});

test('剧本导出要带上分集标题：中文剧本 / Fountain / FDX 三条路都不能把集丢了', () => {
  const p = project();
  const elements = projectToElements(p);
  const headings = elements.filter(e => e.type === 'episode');
  assert.deepEqual(headings.map(e => e.text), ['第 1 集 站台', '第 2 集 钥匙', '（未分集）'], '未分集的场也要说清它不属于任何一集');
  // 集标题必须排在它下面那些场之前
  assert.ok(elements.findIndex(e => e.type === 'episode' && e.text.includes('站台')) < elements.findIndex(e => e.sceneId === 's1'));
  const txt = renderScript(p, 'txt').body;
  assert.match(txt, /【第 1 集 站台】/);
  assert.match(txt, /【第 2 集 钥匙】/);
  assert.match(txt, /【（未分集）】/);
  const fountain = renderScript(p, 'fountain').body;
  assert.match(fountain, /# 第 1 集 站台/);
  assert.match(fountain, /你为什么不走？/);
  const fdx = renderScript(p, 'fdx').body;
  assert.match(fdx, /第 1 集 站台/);
  assert.match(fdx, /<FinalDraft/);
});

test('场次标题三要素要能进剧本（这是"这场在哪、什么时间"唯一的落点）', () => {
  const p = project();
  p.scenes[0].slug = { interior: 'exterior', location: '旧站台', timeOfDay: '夜' };
  const txt = renderScript(p, 'txt').body;
  assert.match(txt, /外景 旧站台 夜/);
  const fdx = renderScript(p, 'fdx').body;
  assert.match(fdx, /EXT\. 旧站台 - 夜/);
  assert.equal(episodeOf(p, p.scenes[0]).id, 'ep1');
  assert.equal(episodeOf(p, p.scenes[2]), null);
});
