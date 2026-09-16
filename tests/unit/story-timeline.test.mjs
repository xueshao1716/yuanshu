// 「片段时间轴」契约：这支片子由哪几段、每段多长、用的是第几版。
//
// 起因是用户看不见成片的构成：分镜顺序拼完了，但"哪几段、每段多长、这版用的是第几版镜头"
// 在全项目里没有任何一个地方能一眼看完。时间轴要说的就是这三件事，所以这里锁的也是这三件事：
// - 时长是**探出来的**（产物记录里根本没有秒数）：探不到就如实 null，绝不拿分镜里写的目标时长顶替；
// - 版本号跟着引擎走，而不是前端自己数——一段失败过两版，同一版在时间轴和「本段结果」里必须是同一个号；
// - 总时长按**默认成片**（每段推荐那一版）合计，且只算探到的段，剩下的如实报"没探到"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fss from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  filmPlan, filmPlanWithDurations, parseDurationSeconds, probeDurationSeconds,
  cachedDurationSeconds, clearDurationCache, runFfmpeg, ffmpegAvailable,
} from '../../engine/story-film.mjs';
import { createStoryOrchestrator } from '../../engine/story-orchestrator.mjs';
import { createProject, writeProject } from '../../engine/story-store.mjs';

const read = rel => fss.readFileSync(path.join(process.cwd(), rel), 'utf8');

async function makeMedia(root, name) {
  const rel = path.join('生成物', '视频', name);
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, 'probe-bytes');
  return { abs, url: `/api/ws/file?path=${encodeURIComponent(rel)}` };
}

test('时长解析：ffprobe 的裸数字与 ffmpeg 的 Duration 行都要认，认不出就说不知道', () => {
  assert.equal(parseDurationSeconds('5.184000\n'), 5.2, 'ffprobe -of default=nw=1:nk=1 只吐一个数字');
  assert.equal(parseDurationSeconds('  Duration: 00:00:05.18, start: 0.000000, bitrate: 2434 kb/s'), 5.2, 'ffmpeg -i 吐的是时间码');
  assert.equal(parseDurationSeconds('Duration: 01:02:03.45'), 3723.5);
  assert.equal(parseDurationSeconds('Duration: N/A'), null, '流式/损坏文件的 Duration 就是 N/A');
  assert.equal(parseDurationSeconds(''), null);
});

test('时长探测：ffprobe 不在就退回 ffmpeg 的 stderr；都没有就说不知道（不抛）', async () => {
  const calls = [];
  const fallback = async cmd => {
    calls.push(cmd);
    if (cmd === 'ffprobe') return { err: new Error('spawn ffprobe ENOENT'), stdout: '', stderr: '' };
    // ffmpeg -i 对没有音轨的文件会以非 0 退出，但 Duration 那行照样在 stderr 里
    return { err: new Error('ffmpeg exited 1'), stdout: '', stderr: 'Input #0, mov\n  Duration: 00:00:12.30, start: 0.0' };
  };
  assert.equal(await probeDurationSeconds('X:/片.mp4', { capture: fallback }), 12.3);
  assert.deepEqual(calls, ['ffprobe', 'ffmpeg'], '探不到才退回 ffmpeg，顺序不能反');
  const nothing = await probeDurationSeconds('X:/片.mp4', { capture: async () => ({ stdout: '', stderr: 'Duration: N/A' }) });
  assert.equal(nothing, null, '探不到就是 null，不能瞎猜一个数填进时间轴');
});

test('时间轴清单：时长按每一版探、总时长按默认成片合计；外链不为一个时长去网络拉片子', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-timeline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const older = await makeMedia(root, 'older.mp4');
  const newer = await makeMedia(root, 'newer.mp4');
  const project = createProject({
    title: '时间轴',
    scenes: [
      {
        id: 's1', index: 1, title: '一场', summary: '', beats: [{ id: 'b1', kind: 'video', prompt: '镜头一', references: [] }, { id: 'b2', kind: 'video', prompt: '镜头二', references: [] }],
        outputs: [
          { id: 'r-old', beatId: 'b1', kind: 'video', status: 'succeeded', createdAt: '2026-09-16T01:00:00.000Z', outputAssets: [{ id: 'a1', type: 'video', url: older.url }] },
          { id: 'r-new', beatId: 'b1', kind: 'video', status: 'degraded', createdAt: '2026-09-16T02:00:00.000Z', outputAssets: [{ id: 'a2', type: 'video', url: newer.url }] },
          { id: 'r-ext', beatId: 'b2', kind: 'video', status: 'succeeded', createdAt: '2026-09-16T03:00:00.000Z', outputAssets: [{ id: 'a3', type: 'video', url: 'https://cdn.example/temp.mp4' }] },
        ],
      },
      { id: 's2', index: 2, title: '二场', summary: '', beats: [{ id: 'b3', kind: 'video', prompt: '镜头三', references: [] }], outputs: [] },
    ],
  }, { id: () => 'pt' });

  const probed = [];
  const plan = await filmPlanWithDurations(project, root, {
    durationOf: async file => { probed.push(path.basename(file)); return path.basename(file) === 'older.mp4' ? 5.2 : 3.8; },
  });

  assert.deepEqual(plan.beats.map(b => b.beatId), ['b1', 'b2', 'b3'], '清单顺序就是分镜顺序');
  assert.deepEqual(plan.beats[0].candidates.map(c => c.runId), ['r-old', 'r-new'], '候选按生成先后排');
  assert.deepEqual(plan.beats[0].candidates.map(c => c.durationSec), [5.2, 3.8], '每一版各自的时长，换版本时总时长要跟着变');
  assert.equal(plan.beats[0].durationSec, 3.8, '段上的时长 = 默认会进片子的那一版');
  assert.equal(plan.beats[1].candidates[0].durationSec, null, '外链还没下载，探不了时长——如实 null');
  assert.equal(plan.beats[1].durationSec, null);
  assert.deepEqual(probed.sort(), ['newer.mp4', 'older.mp4'], '只探本地文件，不为时长去网络拉外链');
  assert.equal(plan.totalDurationSec, 3.8, '合计只算探到的段：b2 没时长、b3 没有可用版本');
  assert.equal(plan.durationKnownBeats, 1);
  assert.equal(plan.durationUnknownBeats, 1, '探不到的段要报出来，不能假装它们是 0 秒');
  // 老接口的行为不能被这套新字段改掉：不带 durations 时，候选项里连这个键都没有
  const plain = filmPlan(project, root);
  assert.equal(plain.beats[0].candidates[0].durationSec, undefined);
  assert.equal(plain.totalDurationSec, undefined);
});

test('版本号由引擎给：一段失败过两版，唯一能用的那版仍是第 3 版（跟「本段结果」同一个号）', () => {
  const project = { scenes: [{ id: 's1', index: 1, beats: [{ id: 'b1', kind: 'video', prompt: 'x' }], outputs: [
    { id: 'r1', beatId: 'b1', status: 'failed', createdAt: '2026-09-16T01:00:00.000Z' },
    { id: 'r2', beatId: 'b1', status: 'failed', createdAt: '2026-09-16T02:00:00.000Z' },
    { id: 'r3', beatId: 'b1', status: 'succeeded', createdAt: '2026-09-16T03:00:00.000Z', outputAssets: [{ type: 'video', url: 'https://cdn.example/ok.mp4' }] },
  ] }] };
  const plan = filmPlan(project, 'D:/pi-workspace');
  assert.equal(plan.beats[0].candidates.length, 1);
  assert.equal(plan.beats[0].candidates[0].versionNo, 3, '版本号要连失败的版本一起数，只数可用候选就会给成第 1 版');
  assert.equal(plan.beats[0].usableCount, 1);
});

test('真的用 ffprobe 探时长（无 ffmpeg 则跳过）；同一文件同一版本第二次吃缓存', async t => {
  if (!(await ffmpegAvailable())) { t.skip('本机没有 ffmpeg'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-probe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=2', '-pix_fmt', 'yuv420p', file]);
  clearDurationCache();
  const sec = await cachedDurationSeconds(file);
  assert.ok(sec != null && Math.abs(sec - 2) < 0.3, `应探到约 2 秒，实得 ${sec}`);
  let probedAgain = 0;
  const again = await cachedDurationSeconds(file, { capture: async () => { probedAgain += 1; return { stdout: '', stderr: '' }; } });
  assert.equal(probedAgain, 0, 'file 没变就该吃缓存，别每开一次面板 spawn 一轮 ffprobe');
  assert.equal(again, sec);
});

test('编排层：不带 durations 就不碰 ffprobe；带了才补时长，探不到也不报错', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-timeline-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const media = await makeMedia(root, 'clip.mp4'); // 内容是假的，"探不到"正是这里要验的那条路
  const project = createProject({
    title: '编排',
    scenes: [{ id: 's1', index: 1, title: '一场', summary: '', beats: [{ id: 'b1', kind: 'video', prompt: 'x', references: [] }],
      outputs: [{ id: 'r1', beatId: 'b1', kind: 'video', status: 'succeeded', createdAt: '2026-09-16T01:00:00.000Z', outputAssets: [{ id: 'a1', type: 'video', url: media.url }] }] }],
  }, { id: () => 'po' });
  await writeProject(root, project);
  const api = createStoryOrchestrator({ root });

  const fast = await api.filmPlan('po');
  assert.equal(fast.beats[0].candidates[0].durationSec, undefined, '默认这条路不能带上探测（每次开面板都要等它）');
  const withDur = await api.filmPlan('po', { durations: true });
  assert.equal(withDur.beats[0].candidates[0].durationSec, null, '探不出来是 null，不是报错、也不是 0');
  assert.equal(withDur.totalDurationSec, null, '一段都没探到就不给总数，而不是报 0 秒');
  assert.equal(withDur.durationUnknownBeats, 1);
  assert.equal(withDur.usable, 1);
});

test('前端契约：时间轴的类名、单段导出入口、durations 只读清单都在', () => {
  const timeline = read('frontend/src/components/story/StoryTimeline.tsx');
  const film = read('frontend/src/components/story/StoryFilm.tsx');
  const css = read('frontend/src/components/story/story.css');
  const api = read('frontend/src/api.ts');
  const server = read('server.mjs');
  const types = read('frontend/src/types.ts');

  assert.match(timeline, /className="story-film-timeline"/, '时间轴要有自己的根节点，真机核对靠它认');
  assert.match(timeline, /story-film-timeline-seg/, '每段一个格子');
  assert.match(timeline, /story-film-timeline-total/, '总时长要看得见');
  assert.match(timeline, /成片第 \{filmNo\} 段/, '改过顺序之后要能把成片位置标出来');
  assert.match(timeline, /preload="metadata"/, '视频缩略图只拉元数据，不能把整支片子拉下来');
  assert.match(timeline, /可用 \$\{beat\.usableCount\} 版/, '每段要标出可用几版');
  assert.match(timeline, /当前用第 \$\{versionNo\} 版/, '每段要标出当前用第几版');
  assert.match(timeline, /onPick\(beat\.beatId, c\.runId\)/, '点一下换成那一版');
  assert.match(timeline, /不会重跑合成/, '换版本不能触发重新合成');
  assert.match(timeline, /还没有片段/, '没有产物的段要如实写，不能占位造假');
  assert.match(timeline, /downloadApiFile\(cand\.url, name, setMessage\)/, '单段导出要复用现成的下载通路');
  assert.match(timeline, /className="btn-ghost story-film-timeline-export"/, '单段导出的入口要能被认出来（真机核对也用它）');
  assert.match(timeline, /成片-第\$\{beat\.beatNo\}段-v\$\{versionNo\}/, '文件名要带段号与版本号');
  assert.match(timeline, /整段不要|加回来/, '"整段不要"沿用合成面板那一套，不另造');
  assert.match(film, /StoryApi\.filmPlan\(project\.id, \{ durations: true \}\)/, '时间轴要拿到时长');
  assert.match(film, /StoryApi\.film\(project\.id, \{ clips: picks \}\)/, '顺序与版本仍然送合成那条路');
  assert.match(film, /<StoryTimeline/, '面板要把时间轴画出来');
  assert.match(css, /\.story-film-timeline-seg/, '样式沿用 story- 前缀与 --pi-* 变量');
  assert.match(api, /filmPlan: \(id: string, opts: \{ durations\?: boolean \} = \{\}\)/, 'filmPlan 加一个可选参数，老调用不带就还是老行为');
  assert.match(api, /durations \? '\?durations=1' : ''/, '只有要时长时才带这个参数');
  assert.match(server, /film-plan\$/, '还是同一个只读路由');
  assert.match(server, /durations: url\.searchParams\.get\('durations'\) === '1'/, '显式开关才走探测');
  assert.match(types, /versionNo\?: number/);
  assert.match(types, /durationSec\?: number \| null/);
  assert.match(types, /StoryTimelinePlan extends StoryFilmPlan/);
});
