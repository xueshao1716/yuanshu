// 删项目契约。
//
// 删整个项目比删一版产出严重得多（人物、分集、脚本、成片历史都在里面），
// 所以这里锁的是**克制**：先留副本、产物文件默认不动、真要清也只清没被别处引用的。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStoryOrchestrator } from '../../engine/story/orchestrator.mjs';
import { createProject, writeProject, listProjects } from '../../engine/story/store.mjs';

async function makeMedia(root, name) {
  const rel = path.join('生成物', '视频', name);
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, 'probe-bytes');
  return { abs, url: `/api/ws/file?path=${encodeURIComponent(rel)}` };
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-delproj-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const api = createStoryOrchestrator({ root, clock: { id: () => 'id', now: () => '2026-09-16T10:00:00.000Z' } });
  const project = createProject({
    title: '要删的项目',
    bible: { characters: [{ id: 'c1', name: '阿宁' }], locations: [], props: [], wardrobe: [], style: {}, rules: [] },
    episodes: [{ id: 'e1', no: 1, title: '一', summary: '' }],
    scenes: [{ id: 's1', index: 1, episodeId: 'e1', title: '一场', summary: '', beats: [{ id: 'b1', kind: 'video', prompt: 'x', references: [] }], outputs: [] }],
  }, { id: () => 'pd' });
  await writeProject(root, project);
  return { root, api, project };
}

test('删项目：从列表消失、留一份副本在 .trash、产物文件默认**不动**', async (t) => {
  const { root, api } = await setup(t);
  const media = await makeMedia(root, 'keep-me.mp4');
  const proj = await api.get('pd');
  proj.scenes[0].outputs.push({ id: 'r1', beatId: 'b1', kind: 'video', status: 'succeeded', createdAt: '2026-09-16T01:00:00.000Z', outputAssets: [{ id: 'a1', type: 'video', url: media.url }] });
  await api.patch('pd', { scenes: proj.scenes });

  const r = await api.deleteProject('pd', {});
  assert.equal(r.title, '要删的项目');
  assert.equal(await listProjects(root).then(list => list.length), 0, '列表里不该再有它');
  await assert.rejects(() => api.get('pd'), /ENOENT/, '记录确实不在了');
  assert.ok((await fs.stat(r.trashCopy)).size > 0, '副本要真的存在（手滑删掉整部戏不可逆）');
  assert.match(r.trashCopy.replace(/\\/g, '/'), /story-projects\/\.trash\//);
  assert.ok((await fs.stat(media.abs)).size > 0, '默认不碰产物文件');
  assert.equal(r.fileDeleted, 0);
  assert.match(r.note, /没有动/);
  assert.match(r.note, /改回来即可恢复/);
  // .trash 不能污染项目列表
  assert.equal((await listProjects(root)).length, 0);
  await assert.rejects(() => api.deleteProject('pd', {}), /ENOENT/, '删两次要报错，不能假装成功');
});

test('删项目 + deleteFiles：只清没被别处引用的文件，被引用的保留并说明', async (t) => {
  const { root, api } = await setup(t);
  const own = await makeMedia(root, 'own.mp4');
  const shared = await makeMedia(root, 'shared.mp4');
  const proj = await api.get('pd');
  proj.scenes[0].outputs.push(
    { id: 'r1', beatId: 'b1', kind: 'video', status: 'succeeded', createdAt: '2026-09-16T01:00:00.000Z', outputAssets: [{ id: 'a1', type: 'video', url: own.url }] },
    { id: 'r2', beatId: 'b1', kind: 'video', status: 'succeeded', createdAt: '2026-09-16T02:00:00.000Z', outputAssets: [{ id: 'a2', type: 'video', url: shared.url }] },
  );
  await api.patch('pd', { scenes: proj.scenes });
  // 另一个项目把 shared 当素材挂上
  const other = createProject({
    title: '引用方',
    scenes: [{ id: 'o1', index: 1, title: 'B', summary: '', beats: [{ id: 'ob1', kind: 'video', prompt: 'x', references: [], inputs: [{ id: 'in1', type: 'video', url: shared.url }] }], outputs: [] }],
  }, { id: () => 'p-other' });
  await writeProject(root, other);

  const r = await api.deleteProject('pd', { deleteFiles: true });
  assert.equal(r.fileDeleted, 1, '没人用的那个删掉');
  assert.equal(r.fileKept, 1, '被别的项目引用的那个留下');
  assert.match(r.files.find(f => !f.deleted).reason, /p-other/, '要说清被谁挡住');
  await assert.rejects(() => fs.stat(own.abs), /ENOENT/);
  assert.ok((await fs.stat(shared.abs)).size > 0);
  assert.equal((await listProjects(root)).length, 1, '别的项目不受影响');
  assert.equal((await listProjects(root))[0].title, '引用方');
});

test('删项目不会顺手删掉别的项目的产物，也不受"自己引用自己"影响', async (t) => {
  const { root, api } = await setup(t);
  const mine = await makeMedia(root, 'mine.mp4');
  const theirs = await makeMedia(root, 'theirs.mp4');
  const proj = await api.get('pd');
  // 同一个文件既在产出里、又被自己的设定当参考图 —— 删自己时不能因为"自己还引用"就永远留着
  proj.bible.characters[0].refImage = mine.url;
  proj.scenes[0].outputs.push({ id: 'r1', beatId: 'b1', kind: 'video', status: 'succeeded', createdAt: '2026-09-16T01:00:00.000Z', outputAssets: [{ id: 'a1', type: 'video', url: mine.url }] });
  await api.patch('pd', { scenes: proj.scenes });
  await writeProject(root, createProject({
    title: '别人的项目',
    scenes: [{ id: 'o1', index: 1, title: 'B', summary: '', beats: [{ id: 'ob1', kind: 'video', prompt: 'x', references: [] }], outputs: [{ id: 'or1', beatId: 'ob1', kind: 'video', status: 'succeeded', createdAt: '2026-09-16T01:00:00.000Z', outputAssets: [{ id: 'oa1', type: 'video', url: theirs.url }] }] }],
  }, { id: () => 'p-other2' }));

  const r = await api.deleteProject('pd', { deleteFiles: true });
  assert.equal(r.fileDeleted, 1, '自己引用的那个也该清掉（项目都删了）');
  await assert.rejects(() => fs.stat(mine.abs), /ENOENT/);
  assert.ok((await fs.stat(theirs.abs)).size > 0, '别人的产物一个都不能碰');
});
