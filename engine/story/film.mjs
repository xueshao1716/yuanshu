// engine/story-film.mjs —— 连续创作「成片合成」
//
// 界面此前明确写着「每次生成一个视频片段，暂不自动拼成长片」。这里把它做掉：
// 按分镜顺序收集每段**成功**的视频产出 → ffmpeg 统一参数归一化 → concat 拼成一条长片。
//
// 为什么不直接 concat：不同片段的编码/分辨率/帧率/音轨常常不一致，concat demuxer
// 要求参数一致，否则会出黑屏、音画不同步或直接失败。所以先各自转成统一中间片再拼。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const list = value => (Array.isArray(value) ? value : []);

// 从产物 URL 解出磁盘路径。生成物统一走签名地址
// /api/ws/file?path=<urlencoded 相对路径>&exp=&sig= ——直接读磁盘，省一次网络往返。
// 非签名地址（http/data）返回空串：交给调用方决定是否走网络。
export function localPathFromArtifactUrl(url, wsRoot) {
  const raw = String(url || '');
  if (!raw) return '';
  if (raw.startsWith('data:') || /^https?:/i.test(raw)) return '';
  if (!raw.startsWith('/api/ws/file')) {
    const abs = path.resolve(wsRoot || '.', raw);
    return withinRoot(abs, wsRoot) ? abs : '';
  }
  const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  const rel = new URLSearchParams(q).get('path') || '';
  if (!rel) return '';
  const abs = path.resolve(wsRoot || '.', rel);
  return withinRoot(abs, wsRoot) ? abs : '';
}

function withinRoot(abs, wsRoot) {
  if (!wsRoot) return true;
  const a = String(abs).replace(/\\/g, '/').toLowerCase();
  const r = String(path.resolve(wsRoot)).replace(/\\/g, '/').toLowerCase();
  return a === r || a.startsWith(r + '/');
}

// 按分镜顺序收集可合成的片段：每段取**最后一次成功**的视频产出。
// 注意：它只看**已经在本地**的文件（同步、不下载）。真正的合成不走这里——
// 合成必须先把外链下载到本地（docs/NAMING.md 第三节的本地化契约），
// 那是异步且有失败原因的，在编排层 story-orchestrator.prepareFilmClips 里做。
export function collectFilmClips(project, wsRoot) {
  const clips = [];
  for (const scene of list(project?.scenes)) {
    for (const beat of list(scene?.beats)) {
      const run = [...list(scene?.outputs)].reverse()
        .find(r => r?.beatId === beat.id && ['succeeded', 'degraded'].includes(r.status) && list(r.outputAssets).length);
      const asset = list(run?.outputAssets).find(a => a?.type === 'video' && a.url);
      const file = localPathFromArtifactUrl(asset?.url, wsRoot);
      if (file && fs.existsSync(file)) clips.push({ sceneId: scene.id, beatId: beat.id, file, url: asset.url });
    }
  }
  return clips;
}

// 某个运行产出里可用的视频文件（合成用）。一段可能一次出好几版，
// 用户要能**挑第几版进片子**——只认"最后一次成功"等于把其余几版白生成了。
export function videoFileOf(run, wsRoot) {
  const asset = list(run?.outputAssets).find(a => a?.type === 'video' && a.url);
  const file = localPathFromArtifactUrl(asset?.url, wsRoot);
  return { asset, file: file && fs.existsSync(file) ? file : '', exists: Boolean(file && fs.existsSync(file)) };
}

// 合成前的**候选清单**：按分镜顺序列出每一段，以及这一段生成过的所有可用版本。
// 界面拿它做"选哪一版、要哪几段、什么顺序"。它只读，不改任何东西、也**不下载**。
//
// 一个版本能不能进片子，取决于两件事：本地文件在不在，或者它是个**能下载的外链**
// （http/data）。早先这里只认本地文件，于是外链版本在界面上显示成"拼不进去"——
// 而本地化契约（docs/NAMING.md 第三节）说得很清楚：外站产物**必须先下载到本地**。
// 拼不进去不是"外链"的错，是没先把它搞到本地。合成时会先下载，所以这里把它算作可用并标出来。
export function filmPlan(project, wsRoot, { localPathOf = localPathFromArtifactUrl } = {}) {
  const beats = [];
  let beatNo = 0;
  for (const scene of list(project?.scenes)) {
    for (const beat of list(scene?.beats)) {
      beatNo += 1;
      // 先按生成先后排**全部** runs（含失败/排队），再挑出能进片子的：
      // 版本号要跟「本段结果」里对得上——那边是"总数 - 从新到旧的位置"，换成从旧到数就是"位置+1"。
      // 只按可用候选编号的话，一段失败过两版，唯一能用的那版会在一处叫第 1 版、另一处叫第 3 版。
      const runs = list(scene?.outputs)
        .filter(r => r?.beatId === beat.id)
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const candidates = runs
        .filter(r => ['succeeded', 'degraded'].includes(r.status))
        .map(r => {
          const asset = list(r.outputAssets).find(a => a?.type === 'video' && a.url);
          const url = String(asset?.url || '');
          const file = localPathOf(url, wsRoot);
          const exists = Boolean(file && fs.existsSync(file));
          const downloadable = /^(https?:|data:)/i.test(url);
          return {
            runId: r.id, status: r.status, seed: r.seed ?? null, createdAt: r.createdAt, url,
            // 第几版：按这一段的全部版本（含失败的）从旧到新数，最新的号最大
            versionNo: runs.indexOf(r) + 1,
            exists, external: /^https?:/i.test(url), downloadable,
            // 可用 = 本地已有，或是个能下载的外链（合成时会先下载到本地）
            localable: exists || downloadable,
            degradation: r.degradation || [],
          };
        });
      const usable = candidates.filter(c => c.localable);
      // 默认推荐：① 用户在「本段结果」里**采用**过的那一版（他挑过就别再替他挑）
      // ② 否则最新的一个可用版本（与"快速合成"一致，用户不改就是原来那版）
      const chosen = usable.find(c => c.runId === beat.chosenRunId);
      beats.push({
        beatId: beat.id, sceneId: scene.id, sceneTitle: scene.title || '', beatNo,
        kind: beat.kind, title: (beat.prompt || beat.dialogue || beat.id).replace(/\s+/g, ' ').slice(0, 60),
        candidates: candidates.map(c => ({ ...c, chosen: c.runId === beat.chosenRunId })),
        usableCount: usable.length,
        externalCount: usable.filter(c => !c.exists).length,
        recommendedRunId: chosen ? chosen.runId : (usable.length ? usable[usable.length - 1].runId : ''),
        // 让界面能说明"这版是你选的"与"这版是按最新的推荐的"
        chosenRunId: chosen ? chosen.runId : '',
      });
    }
  }
  return { beats, usable: beats.filter(b => b.usableCount > 0).length, total: beats.length };
}


// ── 时长探测（时间轴要报"每段多长、合计多长"）───────────────────────────────
//
// 产物记录里**没有时长**：上游只回一个地址，没回秒数。所以时长只能现探——
// 但探测要 spawn 一个进程，而 filmPlan 每次打开面板都会被调，默认绝不能带上它：
// 只有显式 `?durations=1` 才走这条路（见 story-orchestrator 的 filmPlan）。
//
// 两种输出都要认：`ffprobe -show_entries format=duration` 只吐一个裸数字，
// `ffmpeg -i` 吐的是 "Duration: 00:00:05.18"。有些机器只装了 ffmpeg 没有 ffprobe，
// 退回解析 stderr 是唯一还能拿到时长的路（顺带：ffmpeg -i 对没有音轨的文件会"报错"，
// 但那一行 Duration 照样在 stderr 里，所以下面连失败分支也要拿去解析）。
const round1 = value => Math.round(Number(value) * 10) / 10;

export function parseDurationSeconds(text) {
  const raw = String(text || '');
  const clock = raw.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (clock) return round1(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]));
  const bare = raw.trim().match(/^(\d+(?:\.\d+)?)$/);
  return bare ? round1(Number(bare[1])) : null;
}

// 只收 stdout/stderr，**不抛**：探不到时长不是错误，是"这一版没有时长数据"，
// 时间轴如实写"时长未知"就行，不能因为探时长把整张清单带崩。
function execCapture(cmd, args, { timeout = 20000 } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

export async function probeDurationSeconds(file, { capture = execCapture } = {}) {
  if (!file) return null;
  const probed = await capture('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const fromProbe = parseDurationSeconds(probed?.stdout);
  if (fromProbe != null) return fromProbe;
  const fell = await capture('ffmpeg', ['-hide_banner', '-i', file]);
  return parseDurationSeconds(`${fell?.stderr || ''}\n${fell?.stdout || ''}`);
}

// 时长缓存：键带上 size+mtime，文件被重写（重跑一版、做过后处理）就自动失效——
// 拿着旧时长报数比不报数更糟。上限纯粹是防项目多了把内存养大。
const durationCache = new Map();
const DURATION_CACHE_MAX = 2000;

export async function cachedDurationSeconds(file, opts = {}) {
  let key = String(file || '');
  try {
    const st = await fsp.stat(file);
    key = `${key}|${st.size}|${st.mtimeMs}`;
  } catch { return null; } // 文件不在了就如实返回"不知道"
  if (durationCache.has(key)) return durationCache.get(key);
  const value = await probeDurationSeconds(file, opts);
  if (durationCache.size >= DURATION_CACHE_MAX) durationCache.clear();
  durationCache.set(key, value);
  return value;
}

export function clearDurationCache() { durationCache.clear(); }

async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const size = Math.max(1, Math.min(limit, queue.length));
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

// filmPlan + 时长：给每一版候选补 `durationSec`，再算一遍**默认成片**的总时长。
// 只探**已经在本地**的候选：外链还没下载，为了一个时长去网络拉整支片子，
// 就不是 filmPlan 该干的事了（本地化契约里，下载只发生在合成前）。
//
// 逐条 `durationSec` 才是界面的主数据：用户换一版，总时长要跟着变。
// 段上的 `durationSec` 只是"默认那一版多长"，加上 totalDurationSec 一起给只读消费者用。
export async function filmPlanWithDurations(project, wsRoot, { durationOf = cachedDurationSeconds, localPathOf = localPathFromArtifactUrl, concurrency = 4 } = {}) {
  const plan = filmPlan(project, wsRoot, { localPathOf });
  const targets = new Map(); // file → 候选数组：同一文件被两版指向时只探一次
  for (const beat of plan.beats) {
    for (const c of beat.candidates) {
      // 显式写 null 而不是不写：界面要能分清"探过、没有"与"根本没探"（比如老接口给的数据）
      c.durationSec = null;
      if (!c.exists) continue;
      const file = localPathOf(c.url, wsRoot);
      if (!file) continue;
      if (!targets.has(file)) targets.set(file, []);
      targets.get(file).push(c);
    }
  }
  await mapLimit([...targets.entries()], concurrency, async ([file, cands]) => {
    const sec = await durationOf(file);
    if (sec == null) return;
    for (const c of cands) c.durationSec = sec;
  });

  let total = 0; let known = 0; let unknown = 0;
  for (const beat of plan.beats) {
    const rec = beat.candidates.find(c => c.runId === beat.recommendedRunId);
    beat.durationSec = rec?.durationSec ?? null;
    if (!beat.usableCount) continue; // 没有可用版本的段不进总时长，也不该被算成"时长未知"
    // 直接加**已经四舍五入到 0.1 秒**的那一份：界面上一段写 5.2 秒，合计就该等于这几段的 5.2 相加，
    // 而不是拿原始 5.184 求和再舍入（那样用户自己一加就会发现对不上：4×5.2=20.8 ≠ 20.7）。
    if (beat.durationSec == null) unknown += 1; else { total += beat.durationSec; known += 1; }
  }
  return { ...plan, totalDurationSec: known ? round1(total) : null, durationKnownBeats: known, durationUnknownBeats: unknown };
}

export function runFfmpeg(args, { timeout = 900000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err?.message || err).trim().split('\n').slice(-6).join(' / ').slice(0, 500);
        reject(Object.assign(new Error(`ffmpeg 失败：${tail}`), { code: 'FFMPEG' }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function ffmpegAvailable() {
  return new Promise(resolve => {
    execFile('ffmpeg', ['-version'], { timeout: 15000, windowsHide: true }, err => resolve(!err));
  });
}

// 归一化参数：768p 内等比缩放 + 补边 + 30fps + AAC 立体声。
// 这样不同来源的片段拼起来不会变形、不会因为参数不一致而失败。
export const NORMALIZE_ARGS = ['-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2'];

export async function concatClips({ clips = [], outFile, workDir = '', ffmpeg = runFfmpeg } = {}) {
  if (!clips.length) throw Object.assign(new Error('还没有可合成的视频片段：先生成至少一段视频'), { statusCode: 400 });
  if (!outFile) throw new Error('缺少输出路径');
  const dir = workDir || (await fsp.mkdtemp(path.join(os.tmpdir(), 'story-film-')));
  await fsp.mkdir(dir, { recursive: true });

  // 只有一段：直接落盘，不必过 ffmpeg
  if (clips.length === 1) {
    await fsp.copyFile(clips[0].file, outFile);
    return { outFile, clipCount: 1, method: 'copy' };
  }

  const parts = [];
  for (let i = 0; i < clips.length; i++) {
    const part = path.join(dir, `part-${String(i).padStart(3, '0')}.mp4`);
    await ffmpeg(['-y', '-i', clips[i].file, ...NORMALIZE_ARGS, part]);
    parts.push(part);
  }
  const listFile = path.join(dir, 'concat.txt');
  // concat demuxer 的路径写法：单引号包裹，内部单引号需转义
  await fsp.writeFile(listFile, parts.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile]);
  return { outFile, clipCount: clips.length, method: 'concat' };
}
