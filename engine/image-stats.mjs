// engine/image-stats.mjs —— 画面统计（空镜/纯色检测）
//
// 2026-10-19 来源：Huashu-motion 的自检清单里有一条"看关键帧有没有空镜"。
// 今天真跑委托时 B 那一轮就是这样：纯黑底 + 大量留白 + 无文字 → 生成了一张空图，
// 而比例、文案、验活全绿——检查通过但交付不了。
//
// 做法：用 ffmpeg 把图缩到 32×32 灰度取原始像素，算均值/标准差/离群比例。
// 纯色或近乎纯色的画面标准差极低，直接判"疑似空镜"。
// 没有 ffmpeg 就返回 null（调用方只记 info，绝不误判成失败）。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SAMPLE = 32;
/** 标准差低于这个值基本就是纯色/空镜（正常海报通常在 20~60）。 */
export const EMPTY_STDDEV = 6;

export function ffmpegPath(env = process.env) {
  const rt = env.YUANSHU_RUNTIME;
  if (rt) {
    const p = path.join(rt, 'ffmpeg', 'bin', env.OS === 'Windows_NT' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}

/** 从 32×32 灰度原始字节算统计量（纯函数，可单测）。 */
export function statsFromGray(buf, sample = SAMPLE) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const n = Math.min(bytes.length, sample * sample);
  if (n <= 0) return null;
  let sum = 0, sumSq = 0;
  const hist = new Map();
  for (let i = 0; i < n; i++) {
    const v = bytes[i];
    sum += v; sumSq += v * v;
    hist.set(v, (hist.get(v) || 0) + 1);
  }
  const mean = sum / n;
  const stddev = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  // 出现最多的像素值占比：纯色画面会接近 1
  let top = 0;
  for (const c of hist.values()) if (c > top) top = c;
  return { mean: Number(mean.toFixed(1)), stddev: Number(stddev.toFixed(2)), dominantShare: Number((top / n).toFixed(3)), pixels: n };
}

/** 判空镜：标准差过低，或单一像素值占据绝大多数。 */
export function looksEmpty(stats) {
  if (!stats) return false;
  return stats.stddev < EMPTY_STDDEV || stats.dominantShare > 0.985;
}

/**
 * 读一张本地图片的统计量。失败返回 null（不抛）。
 * @returns {Promise<{mean:number,stddev:number,dominantShare:number,pixels:number}|null>}
 */
export function imageStats(file, { exec = execFile, env = process.env, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    try {
      if (!file || !fs.existsSync(file)) return resolve(null);
      const args = ['-v', 'error', '-i', file, '-vf', `scale=${SAMPLE}:${SAMPLE}:force_original_aspect_ratio=disable`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
      exec(ffmpegPath(env), args, { timeout: timeoutMs, maxBuffer: 1024 * 256, encoding: 'buffer', windowsHide: true }, (err, stdout) => {
        if (err || !stdout || !stdout.length) return resolve(null);
        resolve(statsFromGray(stdout));
      });
    } catch { resolve(null) }
  });
}
