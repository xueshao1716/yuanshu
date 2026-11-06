// 「挑片段合成」与「删掉不要的那几版」契约。
//
// 起因是用户的一句话：「有些剧情片段我生成了好几个镜头了」。
// 两个功能都碰**不可逆**的东西，所以这里锁的不是"能不能删/能不能拼"，而是边界：
// - 删记录必成功，但**删文件必须克制**：还在别处被引用就不删，排队中的版本默认不删，外链永不碰磁盘；
// - 挑片段凑不齐时**逐条说明原因**，不能静默少拼一段（少一段比报错难查得多）；
// - 挑出来的成片要记住"用的是哪一版的镜头"，否则事后分不清。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { filmPlan, videoFileOf, localPathFromArtifactUrl } from '../../engine/story/film.mjs';
import { createStoryOrchestrator } from '../../engine/story/orchestrator.mjs';
import { createProject, writeProject } from '../../engine/story/store.mjs';

// 造一个真实存在的文件 + 指向它的签名地址（删文件这条路必须走真磁盘，否则测的是假的）
async function makeMedia(root, name) {
  const rel = path.join('生成物', '视频', name);
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, 'probe-bytes');
  return { abs, url: `/api/ws/file?path=${encodeURIComponent(rel)}` };
}

async function setup(t, { beats = 2 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-film-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '挑片段',
    scenes: [{
      id: 's1', index: 1, title: '一场', summary: '',
      beats: Array.from({ length: beats }, (_, i) => ({ id: `b${i + 1}`, kind: 'video', prompt: `镜头${i + 1}`, references: [] })),
      outputs: [],
    }],
  }, { id: () => 'p1' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({
    root, clock: { id: () => 'run-x', now: () => '2026-09-16T10:00:00.000Z' },
    saveArtifactFromFile: async ({ filePath }) => `/saved/${path.basename(filePath)}`,
  });
  return { root, api, project };
}

async function addRun(api, root, { runId, beatId, url, status = 'succeeded', createdAt, taskId }) {
  const project = await api.get('p1');
  const scene = project.scenes[0];
  scene.outputs.push({
    id: runId, beatId, kind: 'video', status, taskId, createdAt: createdAt || '2026-09-16T01:00:00.000Z', seed: runId.length,
    ...(url ? { outputAssets: [{ id: `${runId}-a`, type: 'video', url }] } : {}),
  });
  await writeProject(root, { ...project, scenes: [scene] });
}

// 采用这一版（beat.chosenRunId）：用户挑过的就别再替他挑——合成分镜时默认用它，
// 而不是"最新的那一版"。这条是「本段结果」里那个「采用这一版」按钮的服务端一半。
test('采用过的那一版优先被推荐（用户挑过的别再替他挑），并在候选里标出来', async t => {
  const { root, api } = await setup(t);
  const older = await makeMedia(root, 'older.mp4');
  const newer = await makeMedia(root, 'newer.mp4');
  await addRun(api, root, { runId: 'r-old', beatId: 'b1', url: older.url, createdAt: '2026-09-16T01:00:00.000Z' });
  await addRun(api, root, { runId: 'r-new', beatId: 'b1', url: newer.url, createdAt: '2026-09-16T05:00:00.000Z' });
  // 没选之前：推荐最新
  assert.equal((await api.filmPlan('p1')).beats[0].recommendedRunId, 'r-new');
  // 采用较旧的那一版
  const project = await api.get('p1');
  project.scenes[0].beats[0].chosenRunId = 'r-old';
  await writeProject(root, project);
  const plan = await api.filmPlan('p1');
  assert.equal(plan.beats[0].recommendedRunId, 'r-old', '采用过的版本要盖过"最新"');
  assert.equal(plan.beats[0].chosenRunId, 'r-old');
  assert.equal(plan.beats[0].candidates.find(c => c.runId === 'r-old').chosen, true);
  assert.equal(plan.beats[0].candidates.find(c => c.runId === 'r-new').chosen, false);
  // 采用了一版但那条 run 已经不可用（被删/外链失效）时，退回最新可用，而不是给一个空推荐
  const p2 = await api.get('p1');
  p2.scenes[0].beats[0].chosenRunId = 'r-gone';
  await writeProject(root, p2);
  const fallback = await api.filmPlan('p1');
  assert.equal(fallback.beats[0].recommendedRunId, 'r-new', '选的那版不在可用候选里就退回最新');
  assert.equal(fallback.beats[0].chosenRunId, '');
});

test('候选清单：本地已有 vs 需要下载（外链）分得清，真的不可用的也如实标出来', async t => {
  const { root, api } = await setup(t);
  const a = await makeMedia(root, 'a.mp4');
  const gone = await makeMedia(root, 'gone.mp4');
  await addRun(api, root, { runId: 'r1', beatId: 'b1', url: a.url, createdAt: '2026-09-16T01:00:00.000Z' });
  await addRun(api, root, { runId: 'r2', beatId: 'b1', url: gone.url, createdAt: '2026-09-16T02:00:00.000Z' });
  await fs.rm(gone.abs); // 本地文件被移走，地址又不是外链 → 真的拼不了
  await addRun(api, root, { runId: 'r3', beatId: 'b2', url: 'https://cdn.example/x.mp4', createdAt: '2026-09-16T03:00:00.000Z' });

  const plan = await api.filmPlan('p1');
  assert.equal(plan.total, 2);
  assert.equal(plan.usable, 2, '本地文件和**可下载的外链**都算可用——外链的错是"还没下"，不是"拼不了"');
  const b1 = plan.beats[0];
  assert.equal(b1.candidates.length, 2);
  assert.deepEqual(b1.candidates.map(c => `${c.runId}:${c.exists}:${c.localable}`), ['r1:true:true', 'r2:false:false'], '文件没了又不是外链 → 真的不可用');
  assert.equal(b1.recommendedRunId, 'r1', '推荐的是真能用的那一版');
  assert.equal(plan.beats[1].recommendedRunId, 'r3', '外链版本可以被推荐：合成时会先下载到本地');
  assert.equal(plan.beats[1].externalCount, 1, '要能看出这一段是外链、得先下载');
  assert.equal(plan.beats[1].candidates[0].localable, true);
});

test('外链片段**先下载到本地**再拼（本地化契约），并把地址写回项目', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-film-ext-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '外链片段',
    scenes: [{
      id: 's1', index: 1, title: '一场', summary: '', beats: [{ id: 'b1', kind: 'video', prompt: '镜头', references: [] }],
      outputs: [{
        id: 'r1', beatId: 'b1', kind: 'video', status: 'degraded', createdAt: '2026-09-16T01:00:00.000Z', promptText: '镜头',
        outputAssets: [{ id: 'a1', type: 'video', url: 'https://cdn.example/temp.mp4' }],
        degradation: ['视频已生成，但没能存到本地（下载失败 HTTP 502）'],
      }],
    }],
  }, { id: () => 'px' });
  await writeProject(root, project);

  // 假的落盘实现：模拟"下载成功、落回本地"
  const downloaded = [];
  const localRel = path.join('生成物', '视频', 'pulled.mp4');
  const localAbs = path.join(root, localRel);
  const localUrl = `/api/ws/file?path=${encodeURIComponent(localRel)}`;
  const api = createStoryOrchestrator({
    root, clock: { id: () => 'run-x', now: () => '2026-09-16T10:00:00.000Z' },
    saveArtifact: async ({ url }) => {
      downloaded.push(url);
      await fs.mkdir(path.dirname(localAbs), { recursive: true });
      await fs.writeFile(localAbs, 'pulled-bytes');
      return { url: localUrl, local: true, reason: '' };
    },
    saveArtifactFromFile: async ({ filePath }) => `/saved/${path.basename(filePath)}`,
  });

  const plan = await api.filmPlan('px');
  const cand = plan.beats[0].candidates[0];
  assert.equal(cand.exists, false, '现在还不是本地文件');
  assert.equal(cand.external, true);
  assert.equal(cand.localable, true, '外链是可下载的 → 算可用');
  assert.equal(plan.usable, 1);

  const r = await api.assembleFilm('px', { clips: [{ beatId: 'b1', runId: 'r1' }] });
  assert.deepEqual(downloaded, ['https://cdn.example/temp.mp4'], '合成前必须先把外链下载到本地');
  assert.equal(r.clipCount, 1);
  assert.equal(r.localized.length, 1);
  assert.equal(r.localized[0].from, 'https://cdn.example/temp.mp4');
  assert.equal(r.localized[0].beatId, 'b1');
  const after = (await api.get('px')).scenes[0].outputs[0];
  assert.match(after.outputAssets[0].url, /^\/api\/ws\/file\?path=/, '外链地址要换成本地地址');
  assert.equal(after.degradation, undefined, '已经落盘了，"没能存到本地"那条降级说明必须去掉——留着就是假话');
  assert.deepEqual((await api.get('px')).films[0].localized, [{ beatId: 'b1', runId: 'r1' }]);
  assert.equal((await api.filmPlan('px')).beats[0].candidates[0].exists, true, '下次再看就已经在本地了，不用重下');

  // 下载不下来：报的是**为什么下不下来**，不是一句含糊的"拼不进去"
  const proj = await api.get('px');
  proj.scenes[0].outputs = [{ id: 'r2', beatId: 'b1', kind: 'video', status: 'succeeded', createdAt: '2026-09-16T02:00:00.000Z', outputAssets: [{ id: 'a2', type: 'video', url: 'https://cdn.example/dead.mp4' }] }];
  await writeProject(root, proj);
  const failing = createStoryOrchestrator({ root, saveArtifact: async () => ({ url: 'https://cdn.example/dead.mp4', local: false, reason: '下载失败 HTTP 502' }), saveArtifactFromFile: async () => '/saved/x.mp4' });
  await assert.rejects(() => failing.assembleFilm('px', { clips: [{ beatId: 'b1', runId: 'r2' }] }), /下载失败 HTTP 502/);
  // 没接入落盘实现：说清是配置问题，而不是含糊的"不在本地"
  const bare = createStoryOrchestrator({ root, saveArtifactFromFile: async () => '/saved/x.mp4' });
  await assert.rejects(() => bare.assembleFilm('px', { clips: [{ beatId: 'b1', runId: 'r2' }] }), /落盘实现未接入/);
});

test('按挑好的版本与顺序合成：成片记下用的是哪一版；挑不出来的逐条说明原因', async t => {
  const { root, api } = await setup(t);
  const a = await makeMedia(root, 'a.mp4');
  const b = await makeMedia(root, 'b.mp4');
  await addRun(api, root, { runId: 'r1', beatId: 'b1', url: a.url, createdAt: '2026-09-16T01:00:00.000Z' });
  await addRun(api, root, { runId: 'r2', beatId: 'b1', url: b.url, createdAt: '2026-09-16T02:00:00.000Z' });

  // 一段 + 一段：两段之间来回拼要多段 ffmpeg，这里只验"挑版本 + 记录 + 跳过原因"，
  // 所以挑**一段**（concatClips 的单段路径是直接复制，不需要 ffmpeg）
  const r = await api.assembleFilm('p1', { clips: [{ beatId: 'b1', runId: 'r1' }] });
  assert.equal(r.clipCount, 1);
  assert.equal(r.method, 'copy');
  assert.deepEqual(r.film.picks, [{ beatId: 'b1', runId: 'r1' }], '要记下用的是哪一版镜头');
  assert.deepEqual(r.film.beatIds, ['b1']);
  const stored = (await api.get('p1')).films;
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].picks, [{ beatId: 'b1', runId: 'r1' }], '重开页面也要能看出这版成片用了第几版');

  // 挑了不存在的运行 / 挑错段 / 挑排队中的：不能静默丢掉
  await addRun(api, root, { runId: 'r9', beatId: 'b2', status: 'running', taskId: 't-1' });
  await assert.rejects(() => api.assembleFilm('p1', { clips: [{ beatId: 'b1', runId: '不存在' }] }), /已经不在了/);
  await assert.rejects(() => api.assembleFilm('p1', { clips: [{ beatId: 'b2', runId: 'r1' }] }), /这一版不属于这一段/);
  await assert.rejects(() => api.assembleFilm('p1', { clips: [{ beatId: 'b2', runId: 'r9' }] }), /状态是「running」/);
  await assert.rejects(() => api.assembleFilm('p1', { clips: [] }), /一个都拼不了/);

  // 混着来：一条能用 + 一条排队中 → 能拼的照拼，不能拼的进 skipped（不静默）
  const mixed = await api.assembleFilm('p1', { clips: [{ beatId: 'b1', runId: 'r2' }, { beatId: 'b2', runId: 'r9' }] });
  assert.equal(mixed.clipCount, 1);
  assert.equal(mixed.skipped.length, 1);
  assert.match(mixed.skipped[0].reason, /running/);
  assert.deepEqual(mixed.film.picks, [{ beatId: 'b1', runId: 'r2' }]);
});

test('不传 clips 时行为不变：每段取最后一次成功、按分镜顺序（老按钮不能因为新功能变样）', async t => {
  const { root, api } = await setup(t);
  const a = await makeMedia(root, 'a.mp4');
  const b = await makeMedia(root, 'b.mp4');
  await addRun(api, root, { runId: 'r1', beatId: 'b1', url: a.url, createdAt: '2026-09-16T01:00:00.000Z' });
  await addRun(api, root, { runId: 'r2', beatId: 'b1', url: b.url, createdAt: '2026-09-16T02:00:00.000Z' });
  const plan = await api.filmPlan('p1');
  assert.equal(plan.beats[0].recommendedRunId, 'r2', '默认推荐最新的成功版本');
  const r = await api.assembleFilm('p1', {});
  assert.equal(r.clipCount, 1);
  assert.equal(r.film.picks, undefined, '没挑过就不写 picks（别让旧数据看起来像"挑过"）');
});

test('删一版：记录必删；文件只在没有别处引用时才删', async t => {
  const { root, api } = await setup(t);
  const own = await makeMedia(root, 'own.mp4');
  const other = await makeMedia(root, 'other.mp4');
  await addRun(api, root, { runId: 'r1', beatId: 'b1', url: own.url });
  await addRun(api, root, { runId: 'r2', beatId: 'b1', url: other.url });

  const r = await api.deleteRun('p1', { sceneId: 's1', runId: 'r1' });
  assert.equal(r.deletedRunId, 'r1');
  assert.equal(r.remaining, 1, '该段还剩一版');
  assert.equal(r.fileDeleted, 1);
  await assert.rejects(() => fs.stat(own.abs), /ENOENT/, '没别处引用时就该把文件删掉');
  assert.ok((await fs.stat(other.abs)).size > 0, '没被删的那一版，文件必须还在');
  const after = await api.get('p1');
  assert.deepEqual(after.scenes[0].outputs.map(x => x.id), ['r2']);
  await assert.rejects(() => api.deleteRun('p1', { sceneId: 's1', runId: 'r1' }), /不存在/);
});

test('删一版：两版指向同一个文件时，删掉其中一版不删文件（另一个还在用）', async t => {
  const { root, api } = await setup(t);
  const same = await makeMedia(root, 'same.mp4');
  await addRun(api, root, { runId: 'r1', beatId: 'b1', url: same.url });
  await addRun(api, root, { runId: 'r2', beatId: 'b1', url: same.url }, );
  const r = await api.deleteRun('p1', { sceneId: 's1', runId: 'r1' });
  assert.equal(r.fileDeleted, 0);
  assert.match(r.files[0].reason, /还被「p1」引用/);
  assert.ok((await fs.stat(same.abs)).size > 0);
});

test('删一版：同一个文件还被别的项目引用时，只移除记录、保留文件', async t => {
  const { root, api } = await setup(t);
  const shared = await makeMedia(root, 'shared.mp4');
  await addRun(api, root, { runId: 'r1', beatId: 'b1', url: shared.url });
  // 另一个项目把同一个文件当素材挂上了
  const other = createProject({
    title: '别的项目',
    scenes: [{ id: 'o1', index: 1, title: 'B', summary: '', beats: [{ id: 'ob1', kind: 'video', prompt: 'x', references: [], inputs: [{ id: 'in1', type: 'video', url: shared.url, name: 'shared.mp4' }] }], outputs: [] }],
  }, { id: () => 'p-other' });
  await writeProject(root, other);

  const r = await api.deleteRun('p1', { sceneId: 's1', runId: 'r1' });
  assert.equal(r.fileDeleted, 0);
  assert.equal(r.fileKept, 1);
  assert.match(r.files[0].reason, /还被「p-other」引用/, '要说清是被谁挡住的');
  assert.ok((await fs.stat(shared.abs)).size > 0, '别的项目还指着这个文件，绝不能删');
});

test('删一版：设定里的参考图与段落挂的素材同样算"被引用"', async t => {
  const { root, api } = await setup(t);
  const portrait = await makeMedia(root, 'portrait.png');
  await addRun(api, root, { runId: 'r1', beatId: 'b1', url: portrait.url });
  // 同一个文件被设成角色定妆照
  const project = await api.get('p1');
  project.bible.characters.push({ id: 'c1', name: '阿宁', refImage: portrait.url });
  await writeProject(root, project);
  const r = await api.deleteRun('p1', { sceneId: 's1', runId: 'r1' });
  assert.equal(r.fileDeleted, 0);
  assert.match(r.files[0].reason, /p1/, '引用它的就是本项目');
  assert.ok((await fs.stat(portrait.abs)).size > 0);
});

test('删一版：排队中的默认拒绝（删了上游出的片子就收不回来了），force 才放行；外链永不碰磁盘', async t => {
  const { root, api } = await setup(t);
  await addRun(api, root, { runId: 'rq', beatId: 'b1', status: 'running', taskId: 'task-abc' });
  await assert.rejects(() => api.deleteRun('p1', { sceneId: 's1', runId: 'rq' }), /还在排队/);
  const forced = await api.deleteRun('p1', { sceneId: 's1', runId: 'rq', force: true });
  assert.equal(forced.deletedRunId, 'rq');

  // 外链：解析不出本地路径 → 不碰磁盘，也不报错
  await addRun(api, root, { runId: 'rext', beatId: 'b1', url: 'https://cdn.example/x.mp4' });
  const ext = await api.deleteRun('p1', { sceneId: 's1', runId: 'rext' });
  assert.equal(ext.fileDeleted, 0);
  assert.match(ext.files[0].reason, /不是本地文件/);
});

test('keepFiles：只移除记录、文件留着（用户自己选的那条路）', async t => {
  const { root, api } = await setup(t);
  const keep = await makeMedia(root, 'keep.mp4');
  await addRun(api, root, { runId: 'rk', beatId: 'b1', url: keep.url });
  const r = await api.deleteRun('p1', { sceneId: 's1', runId: 'rk', keepFiles: true });
  assert.equal(r.fileDeleted, 0);
  assert.equal(r.fileKept, 1);
  assert.match(r.files[0].reason, /你选了/);
  assert.ok((await fs.stat(keep.abs)).size > 0);
});

test('外链产物补下载：只补下载不重新生成；全落下去了才清掉"没落到本地"的说明', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-film-reloc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const localRel = path.join('生成物', '图片', 'pulled.png');
  const localAbs = path.join(root, localRel);
  let attempts = 0;
  const api = createStoryOrchestrator({
    root,
    saveArtifact: async ({ url }) => {
      attempts += 1;
      // 第一次失败、第二次成功：这就是"入库时 CDN 抖了一下"的真实形状
      if (attempts === 1) return { url, local: false, reason: '下载失败 HTTP 502' };
      await fs.mkdir(path.dirname(localAbs), { recursive: true });
      await fs.writeFile(localAbs, 'img-bytes');
      return { url: `/api/ws/file?path=${encodeURIComponent(localRel)}`, local: true, reason: '' };
    },
  });
  const project = createProject({
    title: '补下载',
    scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: 'x', references: [] }],
      outputs: [{ id: 'r1', beatId: 'b1', kind: 'image', status: 'degraded', createdAt: '2026-09-16T01:00:00.000Z',
        outputAssets: [{ id: 'a1', type: 'image', url: 'https://cdn.example/temp.png' }],
        degradation: ['画面已生成，但没能存到本地（下载失败 HTTP 502）'] }] }],
  }, { id: () => 'pl' });
  await writeProject(root, project);

  const bad = await api.localizeRun('pl', { sceneId: 's1', runId: 'r1' });
  assert.equal(bad.localized, 0);
  assert.equal(bad.failed, 1);
  assert.match(bad.results[0].reason, /502/, '失败要说清原因');
  const still = (await api.get('pl')).scenes[0].outputs[0];
  assert.match(still.outputAssets[0].url, /^https:/, '没下下来就不改地址');
  assert.ok(still.degradation, '没下下来就不能把"没落到本地"这条说明抹掉——那是假话');

  const good = await api.localizeRun('pl', { sceneId: 's1', runId: 'r1' });
  assert.equal(good.localized, 1);
  assert.equal(good.failed, 0);
  assert.equal(attempts, 2, '只补下载，不重新生成（没有多花一次生成的钱）');
  const fixed = (await api.get('pl')).scenes[0].outputs[0];
  assert.match(fixed.outputAssets[0].url, /^\/api\/ws\/file\?path=/, '落下去了就把地址换成工作区里的文件');
  assert.equal(fixed.degradation, undefined, '全落下去了才清掉那条说明');
  // 已经在本地的再点一次是幂等的，不会重复下载
  const again = await api.localizeRun('pl', { sceneId: 's1', runId: 'r1' });
  assert.equal(again.localized, 0);
  assert.equal(again.results[0].alreadyLocal, true);
  assert.equal(attempts, 2);
  await assert.rejects(() => api.localizeRun('pl', { sceneId: 's1', runId: '不存在' }), /不存在/);
});

test('filmPlan 只读：不下载、也不碰项目之外的东西（不可用的如实标出来）', async () => {
  const run = { id: 'r', status: 'succeeded', outputAssets: [{ type: 'video', url: 'data:video/mp4;base64,AAAA' }] };
  const got = videoFileOf(run, 'D:/pi-workspace');
  assert.equal(got.exists, false, 'data URL 还不是本地文件');
  assert.equal(got.file, '');
  assert.equal(localPathFromArtifactUrl('https://cdn.example/x.mp4', 'D:/pi-workspace'), '');
  const plan = filmPlan({ scenes: [{ id: 's', beats: [{ id: 'b', kind: 'video', prompt: 'x' }], outputs: [{ id: 'r', beatId: 'b', status: 'succeeded', outputAssets: [{ type: 'video', url: 'https://x/y.mp4' }] }] }] }, 'D:/pi-workspace');
  assert.equal(plan.usable, 1, '外链算可用（合成时会先下载）');
  const c = plan.beats[0].candidates[0];
  assert.equal(c.exists, false);
  assert.equal(c.external, true);
  assert.equal(c.downloadable, true);
  assert.equal(c.localable, true);
  // data URL 也能落回本地（不需要网络）
  const dataPlan = filmPlan({ scenes: [{ id: 's', beats: [{ id: 'b', kind: 'video', prompt: 'x' }], outputs: [{ id: 'r', beatId: 'b', status: 'succeeded', outputAssets: [{ type: 'video', url: 'data:video/mp4;base64,AAAA' }] }] }] }, 'D:/pi-workspace');
  assert.equal(dataPlan.beats[0].candidates[0].localable, true);
  // 既不是本地文件、也不是可下载地址：真的拼不了，如实标出来
  const oddPlan = filmPlan({ scenes: [{ id: 's', beats: [{ id: 'b', kind: 'video', prompt: 'x' }], outputs: [{ id: 'r', beatId: 'b', status: 'succeeded', outputAssets: [{ type: 'video', url: '/nope/missing.mp4' }] }] }] }, 'D:/pi-workspace');
  assert.equal(oddPlan.usable, 0);
  assert.equal(oddPlan.beats[0].candidates[0].localable, false);
});
