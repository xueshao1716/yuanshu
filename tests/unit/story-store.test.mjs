import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, mergeBeatContext, validateProject } from '../../engine/story-store.mjs';

test('createProject returns stable bible and empty scenes', () => {
  const p = createProject({ title: '黄河边的夏天' }, { now: () => '2026-09-12T08:00:00.000Z', id: () => 'p1' });
  assert.equal(p.id, 'p1');
  assert.equal(p.title, '黄河边的夏天');
  assert.deepEqual(p.bible, { characters: [], locations: [], props: [], wardrobe: [], style: {}, rules: [] });
  assert.deepEqual(p.scenes, []);
});

test('mergeBeatContext keeps ordered inherited entities and rejects cycles', () => {
  const project = { bible: { characters: [{ id: 'c1', name: '阿宁' }], locations: [], props: [], wardrobe: [], style: { tone: '电影感' }, rules: [] } };
  const scene = { beats: [
    { id: 'b1', references: [{ id: 'c1', role: 'character' }], prompt: '站在河边' },
    { id: 'b2', references: [], inheritFromBeatId: 'b1', prompt: '回头' },
  ] };
  const result = mergeBeatContext(project, scene, scene.beats[1]);
  assert.deepEqual(result.referenceIds, ['c1']);
  assert.equal(result.prompt, '站在河边\n回头');
  assert.throws(() => mergeBeatContext(project, { beats: [{ id: 'a', inheritFromBeatId: 'b' }, { id: 'b', inheritFromBeatId: 'a' }] }, { id: 'a', inheritFromBeatId: 'b' }), /循环/);
});

test('validateProject rejects duplicate scene indexes', () => {
  assert.throws(() => validateProject({ id: 'p1', title: 'x', scenes: [{ id: 's1', index: 1 }, { id: 's2', index: 1 }] }), /index/);
});

// createProject 是白名单式构造：新字段不在这里登记，写进去就读不回来。
// 这条铁律已经被踩过四次（默认配方/分集/改编史/方法包/深度构思），配色卡是第五个。
test('配色卡：createProject 必须登记 colorCardId，否则写进去读不回来', () => {
  const withCard = createProject({ title: 'x', colorCardId: 'morandi-violet-pink' });
  assert.equal(withCard.colorCardId, 'morandi-violet-pink');
  const without = createProject({ title: 'x' });
  assert.equal('colorCardId' in without, false, '没选配色就不该凭空多一个字段');
});

// 一键分镜会产出多个场景，第 2 场第 1 段承接第 1 场末段。原先校验只在本场景内查 id，
// 于是这种跨场景续写会被拒。跨场景连续性本来就该成立，这里锁住它。
test('跨场景继承：校验通过，且前文能从 owning scene 取到', () => {
  const project = {
    id: 'p1', title: 'x',
    bible: { characters: [{ id: 'c1', name: '阿宁' }], locations: [], props: [], wardrobe: [], style: {}, rules: [] },
    scenes: [
      { id: 's1', index: 1, beats: [{ id: 'b1', references: [{ id: 'c1', role: 'character' }], prompt: '站在河边' }], outputs: [{ beatId: 'b1', status: 'succeeded', outputAssets: [{ type: 'text', text: '他站在河边，风很大。' }] }] },
      { id: 's2', index: 2, beats: [{ id: 'b2', references: [], inheritFromBeatId: 'b1', prompt: '转身离开' }], outputs: [] },
    ],
  };
  assert.doesNotThrow(() => validateProject(project));
  const result = mergeBeatContext(project, project.scenes[1], project.scenes[1].beats[0]);
  assert.deepEqual(result.referenceIds, ['c1']);
  assert.match(result.prompt, /站在河边/);
  assert.match(result.prompt, /他站在河边，风很大。/);
  assert.match(result.prompt, /转身离开/);
});

test('跨场景继承仍然拒绝不存在的 id', () => {
  assert.throws(() => validateProject({ id: 'p1', title: 'x', scenes: [
    { id: 's1', index: 1, beats: [{ id: 'b1' }] },
    { id: 's2', index: 2, beats: [{ id: 'b2', inheritFromBeatId: 'nope' }] },
  ] }), /继承 beat 不存在/);
});
