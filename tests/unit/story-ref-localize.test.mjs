// 参考图（定妆照/场景/道具）也受**本地化契约**约束（docs/NAMING.md 第三节）。
//
// 为什么单独锁这一块：参考图是要**长期复用的锚点**，挂在会过期的外站临时链接上，
// 几天后人物一致性就悄悄失效——而界面此前看起来是"生成成功"。
// 让 `generateAssetRef` 返回 localizeError 只是第一步，还得有一个"补下载"的动作能救回来。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStoryOrchestrator } from '../../engine/story/orchestrator.mjs';
import { createProject, writeProject } from '../../engine/story/store.mjs';

async function setup(t, { saveArtifact } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-ref-local-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pulled = [];
  const api = createStoryOrchestrator({
    root,
    clock: { id: () => 'id-x', now: () => '2026-09-16T10:00:00.000Z' },
    saveArtifact: saveArtifact || (async ({ url, type }) => {
      pulled.push(url);
      const ext = type === 'video' ? 'mp4' : 'png';
      const rel = path.join('生成物', type === 'video' ? '视频' : '图片', `pulled-${pulled.length}.${ext}`);
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), 'bytes');
      return { url: `/api/ws/file?path=${encodeURIComponent(rel)}`, local: true, reason: '' };
    }),
  });
  const project = createProject({
    title: '参考图本地化',
    bible: {
      characters: [{ id: 'c1', name: '阿宁', appearance: '短发', refImage: 'https://cdn.example/anning.png' }],
      locations: [{ id: 'l1', name: '旧站台', refImage: 'https://cdn.example/platform.png' }],
      props: [{ id: 'p1', name: '钥匙', refImage: '/api/ws/file?path=already-local.png' }],
      wardrobe: [], style: {}, rules: [],
    },
    scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [{ id: 'b1', kind: 'image', prompt: 'x', references: [] }],
      outputs: [{ id: 'r1', beatId: 'b1', kind: 'image', status: 'succeeded', createdAt: '2026-09-16T01:00:00.000Z', promptText: 'x',
        outputAssets: [{ id: 'a1', type: 'image', url: 'https://cdn.example/frame.png' }],
        degradation: ['画面已生成，但没能存到本地（下载失败 HTTP 502）'] }] }],
  }, { id: () => 'pr' });
  await writeProject(root, project);
  return { root, api, pulled };
}

test('全项目补下载：参考图与产出一起拉到本地并写回；已在本地的不重下', async (t) => {
  const { root, api, pulled } = await setup(t);
  const r = await api.localizeProject('pr', { scope: 'all' });
  assert.equal(r.localized, 3, '两张外链参考图 + 一个外链产出');
  assert.equal(r.failed, 0);
  assert.deepEqual(pulled.sort(), ['https://cdn.example/anning.png', 'https://cdn.example/frame.png', 'https://cdn.example/platform.png'].sort());
  const after = await api.get('pr');
  assert.match(after.bible.characters[0].refImage, /^\/api\/ws\/file\?path=/, '定妆照要换成工作区里的文件');
  assert.match(after.bible.locations[0].refImage, /^\/api\/ws\/file\?path=/);
  assert.equal(after.bible.props[0].refImage, '/api/ws/file?path=already-local.png', '本来就在本地的不动');
  assert.match(after.scenes[0].outputs[0].outputAssets[0].url, /^\/api\/ws\/file\?path=/);
  assert.equal(after.scenes[0].outputs[0].degradation, undefined, '全下完了才清掉"没落到本地"那条说明');
  for (const item of r.items.filter(x => x.kind === 'ref')) assert.ok(item.itemId, '每一项都要说清是哪个条目');
  // 再来一次：全都是 alreadyLocal，不重复下载
  const again = await api.localizeProject('pr', { scope: 'all' });
  assert.equal(again.localized, 0);
  assert.equal(pulled.length, 3, '第二次不应该再多下载');
});

test('补下载失败：保留原地址与原说明，逐项给出原因（不许含糊）', async (t) => {
  const { api } = await setup(t, {
    saveArtifact: async ({ url }) => ({ url, local: false, reason: url.includes('platform') ? '下载失败 HTTP 502' : '地址指向内网/回环，出于安全拒绝下载' }),
  });
  const r = await api.localizeProject('pr', { scope: 'all' });
  assert.equal(r.localized, 0);
  assert.equal(r.failed, 3);
  const reasons = r.items.filter(x => !x.ok).map(x => x.reason).join(' | ');
  assert.match(reasons, /HTTP 502/, '原因要原样带出来');
  assert.match(reasons, /内网/, 'SSRF 拦下的也要如实说，不能假装成功');
  const after = await api.get('pr');
  assert.match(after.bible.characters[0].refImage, /^https:/, '没下下来就不改地址');
  assert.ok(after.scenes[0].outputs[0].degradation, '没下下来就不能清掉那条说明——那是假话');
});

test('范围可选：只补参考图 / 只补产出；挂载素材不重复落盘且明说', async (t) => {
  const { api, pulled } = await setup(t);
  const refs = await api.localizeProject('pr', { scope: 'refs' });
  assert.equal(refs.localized, 2);
  assert.deepEqual(pulled.sort(), ['https://cdn.example/anning.png', 'https://cdn.example/platform.png']);
  assert.match((await api.get('pr')).scenes[0].outputs[0].outputAssets[0].url, /^https:/, 'scope=refs 时不动产出');

  // 段落挂载的素材（别的工作台的产物）：不重复落盘，但必须**明说**为什么
  const proj = await api.get('pr');
  proj.scenes[0].beats[0].inputs = [{ id: 'in1', type: 'video', url: 'https://cdn.example/other-workshop.mp4', name: '别的工作台的产物' }];
  await api.patch('pr', { scenes: proj.scenes });
  const runs = await api.localizeProject('pr', { scope: 'runs' });
  assert.equal(runs.localized, 1, '只补运行产出');
  assert.equal(runs.skipped.length, 1, '挂载素材要被明确跳过');
  assert.match(runs.skipped[0].reason, /不重复落盘|引用/, '要说清挂载素材为什么不落盘');
  assert.equal((await api.localizeProject('pr', { scope: 'all' })).skipped.length, 1);
});

test('入库时没落到本地：generateAssetRef 必须把 localizeError 带出来（否则界面看起来是成功的）', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-ref-warn-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = createProject({
    title: '参考图未落盘',
    bible: { characters: [{ id: 'c1', name: '阿宁', appearance: '短发' }], locations: [], props: [], wardrobe: [], style: {}, rules: [] },
    scenes: [{ id: 's1', index: 1, title: '一', summary: '', beats: [], outputs: [] }],
  }, { id: () => 'pw' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({
    root,
    adapters: {
      // 上游给了图，但落盘失败 → saveArtifact 返回外站地址 + reason，适配器把 localizeError 带在 output 上
      image: { generate: async () => ({ status: 'succeeded', output: { type: 'image', url: 'https://cdn.example/new.png', localizeError: '下载失败 HTTP 502' } }) },
    },
  });
  const r = await api.generateAssetRef('pw', { assetType: 'character', assetId: 'c1' });
  assert.equal(r.status, 'succeeded', '生成是成功的（图有了）');
  assert.equal(r.image, 'https://cdn.example/new.png');
  assert.equal(r.localizeError, '下载失败 HTTP 502');
  assert.match(r.note, /没能存到本地/, '要明确告诉用户"没落到本地"');
  assert.match(r.note, /外站临时链接.*过期/, '要说清后果：外链会过期');
  assert.match(r.note, /拉到本地/, '要指向补救入口');
  // 全部落盘成功时不该有这条 note
  const okApi = createStoryOrchestrator({ root, adapters: { image: { generate: async () => ({ status: 'succeeded', output: { type: 'image', url: '/api/ws/file?path=x.png' } }) } } });
  const ok = await okApi.generateAssetRef('pw', { assetType: 'character', assetId: 'c1' });
  assert.equal(ok.localizeError, undefined);
  assert.equal(ok.note, undefined);
});
