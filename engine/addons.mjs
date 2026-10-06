// 可选组件：安装包只带「聊天 + 文档 + 命令」的基本盘，较重、只在部分场景用到的能力按需联网安装。
// 小语遇到缺组件时可以自己装（node scripts/addon.mjs install <id>），系统页「环境体检」也有一键安装。
// 下载源全部选国内直连可用的镜像（npmmirror / hf-mirror / 阿里云 PyPI），失败再退回官方源；二进制一律校验 sha256。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';

const PIP_INDEXES = ['https://mirrors.aliyun.com/pypi/simple', 'https://pypi.tuna.tsinghua.edu.cn/simple', 'https://pypi.org/simple'];

const FFMPEG_BASE = ['https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1', 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1'];
// 解压后的 exe 的 sha256（下载的 .gz 在不同镜像上可能重新压缩过，校验解压后的结果）
export const FFMPEG_SHA = {
  ffmpeg: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
  ffprobe: '3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4',
};

const U2NET = {
  sha256: '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491',
  urls: [
    'https://hf-mirror.com/tomjackson2023/rembg/resolve/main/u2net.onnx',
    'https://huggingface.co/tomjackson2023/rembg/resolve/main/u2net.onnx',
    'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx',
  ],
};

// 组件所在的运行时根目录：安装版由 launcher 设置 YUANSHU_RUNTIME；源码版落到用户目录，避免写进仓库
export function runtimeRoot(env = process.env) {
  return env.YUANSHU_RUNTIME || path.join(env.USERPROFILE || os.homedir(), '.yuanshu', 'runtime');
}
export const ffmpegBin = (env) => path.join(runtimeRoot(env), 'ffmpeg', 'bin');
export const modelsDir = (env) => env?.U2NET_HOME || path.join(runtimeRoot(env), 'models');

function runDefault(cmd, args, { timeout = 15 * 60 * 1000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8', env: env || process.env, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
    });
  });
}

const pyMods = (mods) => `import importlib,json\nr={}\nfor n in ${JSON.stringify(mods)}:\n  try: importlib.import_module(n); r[n]=True\n  except Exception: r[n]=False\nprint(json.dumps(r))`;

async function pyHas(run, mods) {
  const r = await run('python', ['-c', pyMods(mods)], { timeout: 60000 });
  if (!r.ok) return false;
  try { return Object.values(JSON.parse(r.out.split(/\r?\n/).pop())).every(Boolean); } catch { return false; }
}

async function pipInstall(run, pkgs, log) {
  let last = '';
  for (const index of PIP_INDEXES) {
    log(`pip 安装 ${pkgs.join(' ')}（源：${new URL(index).host}）`);
    const r = await run('python', ['-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check', '-i', index, ...pkgs], {});
    if (r.ok) return;
    last = (r.err || r.out).split(/\r?\n/).slice(-3).join(' ');
    log(`失败：${last.slice(0, 200)}`);
  }
  throw new Error(`pip 安装失败：${last.slice(0, 300)}`);
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

// 下载到 dst（可选 gunzip），校验 sha256；多个源依次尝试
async function download({ urls, dst, gunzip = false, sha256 = '', fetchImpl = fetch, log }) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  let last = '';
  for (const url of urls) {
    const part = dst + '.part';
    try {
      log(`下载 ${url}`);
      const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(20 * 60 * 1000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const src = Readable.fromWeb(res.body);
      await (gunzip ? pipeline(src, zlib.createGunzip(), fs.createWriteStream(part)) : pipeline(src, fs.createWriteStream(part)));
      if (sha256) {
        const got = await sha256File(part);
        if (got !== sha256) throw new Error(`校验失败（sha256 ${got.slice(0, 12)}…）`);
      }
      fs.renameSync(part, dst);
      return;
    } catch (e) {
      fs.rmSync(part, { force: true });
      last = e?.message || String(e);
      log(`失败：${last}`);
    }
  }
  throw new Error(`下载失败：${last}`);
}

function prependPath(dir, env = process.env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const parts = String(env[key] || '').split(path.delimiter).filter(Boolean);
  if (!parts.includes(dir)) env[key] = [dir, ...parts].join(path.delimiter);
}

export const ADDONS = [
  {
    id: 'media', label: '音视频处理（ffmpeg）', size: '下载约 60MB',
    use: '视频合成、配音拼接、抽帧、格式转换',
    async check({ run }) { return (await run('ffmpeg', ['-version'], { timeout: 10000 })).ok && (await run('ffprobe', ['-version'], { timeout: 10000 })).ok; },
    async install({ env, fetchImpl, log, run }) {
      const bin = ffmpegBin(env);
      for (const name of ['ffmpeg', 'ffprobe']) {
        await download({ urls: FFMPEG_BASE.map((b) => `${b}/${name}-win32-x64.gz`), dst: path.join(bin, `${name}.exe`), gunzip: true, sha256: FFMPEG_SHA[name], fetchImpl, log });
      }
      prependPath(bin, env);
      const v = await run('ffmpeg', ['-version'], { timeout: 15000 });
      if (!v.ok) throw new Error(`ffmpeg 装好了但运行失败：${v.err.slice(0, 200)}`);
    },
  },
  {
    id: 'cutout', label: '抠图（rembg + u2net 模型）', size: '下载约 230MB',
    use: '去背景、商品图/人像抠图、贴纸',
    async check({ run, env }) { return fs.existsSync(path.join(modelsDir(env), 'u2net.onnx')) && pyHas(run, ['rembg', 'onnxruntime']); },
    async install({ env, fetchImpl, log, run }) {
      await pipInstall(run, ['rembg[cpu]==2.0.84'], log);
      const dir = modelsDir(env);
      const dst = path.join(dir, 'u2net.onnx');
      if (!fs.existsSync(dst) || (await sha256File(dst)) !== U2NET.sha256) await download({ urls: U2NET.urls, dst, sha256: U2NET.sha256, fetchImpl, log });
      env.U2NET_HOME = dir;
    },
  },
  {
    id: 'data', label: '数据分析（pandas）', size: '下载约 30MB',
    use: '表格清洗、统计、大批量 Excel/CSV 处理',
    check: ({ run }) => pyHas(run, ['pandas', 'numpy']),
    install: ({ run, log }) => pipInstall(run, ['pandas', 'numpy'], log),
  },
  {
    id: 'pdf', label: 'PDF 读写（PyMuPDF）', size: '下载约 20MB',
    use: 'PDF 提取文字/图片、拆分合并、转图片',
    check: ({ run }) => pyHas(run, ['fitz']),
    install: ({ run, log }) => pipInstall(run, ['pymupdf'], log),
  },
];

const byId = (id) => ADDONS.find((a) => a.id === id);

export async function listAddons({ run = runDefault, env = process.env } = {}) {
  return Promise.all(ADDONS.map(async (a) => ({ id: a.id, label: a.label, size: a.size, use: a.use, installed: await a.check({ run, env }).catch(() => false) })));
}

export async function installAddon(id, { run = runDefault, env = process.env, fetchImpl = fetch, log = () => {} } = {}) {
  const a = byId(id);
  if (!a) throw new Error(`没有这个组件：${id}（可选：${ADDONS.map((x) => x.id).join(' / ')}）`);
  if (await a.check({ run, env }).catch(() => false)) { log(`${a.label} 已经装好了`); return { id, already: true }; }
  await a.install({ run, env, fetchImpl, log });
  if (!(await a.check({ run, env }).catch(() => false))) throw new Error(`${a.label} 安装后检查未通过`);
  log(`${a.label} 安装完成`);
  return { id, already: false };
}

// 后台任务：页面点一下就返回，轮询看进度；同一组件同时只跑一个
const jobs = new Map();
export function startAddonJob(id, deps = {}) {
  if (!byId(id)) throw new Error(`没有这个组件：${id}`);
  const cur = jobs.get(id);
  if (cur?.state === 'running') return cur;
  const job = { id, state: 'running', log: [], startedAt: Date.now(), error: '' };
  jobs.set(id, job);
  const log = (m) => { job.log.push(m); if (job.log.length > 40) job.log.shift(); };
  installAddon(id, { ...deps, log }).then(() => { job.state = 'done'; }, (e) => { job.state = 'error'; job.error = e?.message || String(e); });
  return job;
}
export const addonJobs = () => Object.fromEntries([...jobs].map(([k, v]) => [k, { state: v.state, log: v.log.slice(-6), error: v.error }]));

// 服务启动时调用：源码版把用户目录下已装的 ffmpeg 加进 PATH（安装版由 launcher 统一设置）
export function ensureAddonPaths(env = process.env) {
  const bin = ffmpegBin(env);
  if (fs.existsSync(path.join(bin, 'ffmpeg.exe')) || fs.existsSync(path.join(bin, 'ffmpeg'))) prependPath(bin, env);
  const models = modelsDir(env);
  if (!env.U2NET_HOME && fs.existsSync(path.join(models, 'u2net.onnx'))) env.U2NET_HOME = models;
}
