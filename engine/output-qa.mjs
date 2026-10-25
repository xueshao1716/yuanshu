// ===== output-qa.mjs —— 交付前的"证据检查"（2026-10-25）=====
//
// 灵感来自 earshot（https://github.com/Leonxlnx/earshot）：**把感官变成证据**，
// 让模型不是"感觉到了"，而是读到「LUFS -16.2 / 真峰值 -1.3 / 音画时长差 0.02s / 声画同步 3 处偏差」。
//
// 元枢原来的交付验收是假的：文件在 + 大小 >0 + ffprobe 能读，就算成功。
// 于是出现过"渲染成功 12.8MB"，但没人知道那声"咚"是不是落在剪辑点上、整体响度合不合规。
//
// 这里做两件事（都不依赖任何大模型）：
//   1. measureAudio()：ffmpeg ebur128 测 LUFS / 真峰值，ffprobe 读流信息与时长；
//   2. checkOutput()：按交付类型的硬门槛预筛（pre-screen），不合格就**先拦下来**，
//      只有过了预筛的才值得让模型/人去看。这是 earshot 那套"先筛后评"的搬法。
// 如果装了 earshot（`earshot measure -j`），会优先用它，并把它的结论一并记进交付说明。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const AUDIO_LUFS_RANGE = [-24, -10];     // 交付常用区间（-16 主流，-14 流媒体）
export const TRUE_PEAK_MAX = -1;                // 不能超过 -1 dBTP
export const MAX_AV_DRIFT_SEC = 0.5;            // 音画时长差上限

const ff = (name) => process.env[`YUANSHU_${name.toUpperCase()}`] || name;

/**
 * 跑命令并**合并 stderr**：ffmpeg 的 ebur128 摘要、ffprobe 的报错都在 stderr 里。
 * 2026-10-25 真机踩过：只用 execFileSync 的返回值（stdout），响度永远测不到，
 * 于是"预筛通过"却对声音一无所知——比不测更糟，因为它给了假的安全感。
 */
function run(cmd, args, timeout = 120000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.error || r.status === null) {
    return { ok: false, out, err: String(r.error?.message || "timeout").slice(0, 300), code: r.status ?? -1 };
  }
  return { ok: r.status === 0, out, err: r.status === 0 ? "" : String(r.stderr || "").slice(0, 300), code: r.status };
}

/** 找 earshot CLI（装了就用，没装也不影响）。 */
export function detectEarshot() {
  const cands = [process.env.YUANSHU_EARSHOT, 'earshot'].filter(Boolean);
  for (const c of cands) {
    const r = run(c, ['--help'], 8000);
    if (r.ok || /usage|command/i.test(r.out + r.err)) return c;
  }
  return null;
}

/** ffprobe 读流信息（时长、分辨率、fps、有无音轨）。 */
export function probeMedia(file) {
  const r = run(ff('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 30000);
  if (!r.ok) return { ok: false, error: r.err || 'ffprobe 失败' };
  try {
    const j = JSON.parse(r.out);
    const streams = j.streams || [];
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    const fps = v?.avg_frame_rate && v.avg_frame_rate !== '0/0'
      ? (() => { const [n, d] = String(v.avg_frame_rate).split('/').map(Number); return d ? Math.round((n / d) * 100) / 100 : null; })()
      : (v?.r_frame_rate ? Number(String(v.r_frame_rate).split('/')[0]) / Number(String(v.r_frame_rate).split('/')[1] || 1) : null);
    return {
      ok: true,
      durationSec: Number(j.format?.duration) || Number(v?.duration) || null,
      sizeBytes: Number(j.format?.size) || null,
      hasVideo: !!v, hasAudio: !!a,
      width: v?.width || null, height: v?.height || null, fps: Number.isFinite(fps) ? fps : null,
      videoCodec: v?.codec_name || null, audioCodec: a?.codec_name || null,
      audioDurationSec: a?.duration ? Number(a.duration) : null,
      videoDurationSec: v?.duration ? Number(v.duration) : null,
    };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
}

/** 从 ffmpeg ebur128 输出里抠 LUFS / 真峰值（纯函数，便于单测）。
 *
 * 2026-10-25 真机踩过：ebur128 在**处理过程中每行**都会打 `I: … LUFS`（开头是静音，能到 -70），
 * 最后的整段汇总在 `Summary:` 之后。取第一个匹配就会把"开头静音"当成整体响度——
 * 明明是 -16 dB 的片子，报成 -70，看起来像没声。所以只认 Summary 段。
 */
export function parseLoudness(text) {
  const s = String(text || '');
  const at = s.lastIndexOf('Summary:');
  const summary = at >= 0 ? s.slice(at) : s;
  const num = (src, re) => { const m = src.match(re); return m ? Number(m[1]) : null; };
  return {
    lufs: num(summary, /\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/) ?? num(summary, /Integrated loudness:\s*(-?\d+(?:\.\d+)?)/),
    truePeak: num(summary, /\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/) ?? num(summary, /True peak:\s*(-?\d+(?:\.\d+)?)/),
    lra: num(summary, /\bLRA:\s*(-?\d+(?:\.\d+)?)\s*LU/),
  };
}

/** 测响度（ebur128，纯 ffmpeg，不需要模型）。 */
export function measureLoudness(file) {
  const r = run(ff('ffmpeg'), ['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'], 120000);
  const parsed = parseLoudness(r.out + ' ' + r.err);
  if (parsed.lufs == null && parsed.truePeak == null) return { ok: false, error: '没测到响度（可能没有音轨）' };
  return { ok: true, ...parsed };
}

/** 优先用 earshot 的 measure（含频谱/节拍），拿不到就退回 ffmpeg。 */
export function measureAudio(file) {
  const ex = detectEarshot();
  if (ex) {
    const r = run(ex, ['measure', file, '-j'], 180000);
    if (r.ok) {
      try {
        const j = JSON.parse(r.out);
        return { ok: true, source: 'earshot', ...j, ...(measureLoudness(file).ok ? { loudness: measureLoudness(file) } : {}) };
      } catch {}
    }
  }
  const loud = measureLoudness(file);
  return { ok: loud.ok, source: 'ffmpeg', ...loud };
}

/** 音画时长差（同步的最粗证据）。 */
export function avDriftSec(info) {
  if (!info?.hasAudio || !info?.hasVideo) return null;
  const a = info.audioDurationSec ?? info.durationSec;
  const v = info.videoDurationSec ?? info.durationSec;
  if (!Number.isFinite(a) || !Number.isFinite(v)) return null;
  return Math.round(Math.abs(a - v) * 1000) / 1000;
}

/**
 * 交付前预筛：只做**客观、可解释**的判定，不合格就拦。
 * @returns {{pass:boolean, fails:string[], warnings:string[], evidence:object}}
 */
export function checkOutput(file, { kind = 'auto', fileExists = fs.existsSync } = {}) {
  const fails = [];
  const warnings = [];
  if (!file || !fileExists(file)) return { pass: false, fails: ['文件不存在'], warnings, evidence: { file } };
  const size = (() => { try { return fs.statSync(file).size; } catch { return 0 } })();
  if (!size) fails.push('文件是 0 字节');
  const ext = path.extname(file).toLowerCase();
  const isAudioOnly = kind === 'audio' || ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'].includes(ext);
  const isMedia = isAudioOnly || ['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(ext);
  const evidence = { file, sizeBytes: size, ext };

  if (isMedia) {
    const info = probeMedia(file);
    evidence.probe = info;
    if (!info.ok) fails.push(`ffprobe 读不了：${info.error}`);
    else {
      if (isAudioOnly && !info.hasAudio) fails.push('音频文件里没有音轨');
      if (!isAudioOnly && !info.hasVideo) fails.push('视频文件里没有画面');
      if (!(Number(info.durationSec) > 0.3)) fails.push(`时长异常（${info.durationSec}s）`);
      if (info.hasAudio) {
        const loud = measureLoudness(file);
        evidence.loudness = loud;
        if (loud.ok) {
          if (loud.lufs != null && (loud.lufs < AUDIO_LUFS_RANGE[0] || loud.lufs > AUDIO_LUFS_RANGE[1])) {
            warnings.push(`整体响度 ${loud.lufs} LUFS 超出交付常用区间 ${AUDIO_LUFS_RANGE.join('~')}`);
          }
          if (loud.truePeak != null && loud.truePeak > TRUE_PEAK_MAX) {
            fails.push(`真峰值 ${loud.truePeak} dBTP 超过 ${TRUE_PEAK_MAX}（会削波）`);
          }
        } else warnings.push('没测到响度（可能是静音或无音轨）');
      }
      if (info.hasAudio && info.hasVideo) {
        const drift = avDriftSec(info);
        evidence.avDriftSec = drift;
        if (drift != null && drift > MAX_AV_DRIFT_SEC) fails.push(`音画时长差 ${drift}s（>${MAX_AV_DRIFT_SEC}s，可能音轨没对齐）`);
      }
      if (!isAudioOnly && info.fps != null && info.fps < 20) warnings.push(`帧率偏低（${info.fps}fps）`);
    }
  }
  return { pass: fails.length === 0, fails, warnings, evidence };
}

/** 一行交付说明里的话（给人看，也给模型读）。 */
export function evidenceNote(check) {
  const e = check?.evidence || {};
  const bits = [];
  if (e.sizeBytes) bits.push(`${(e.sizeBytes / 1024 / 1024).toFixed(1)}MB`);
  const p = e.probe || {};
  if (p.durationSec) bits.push(`${p.durationSec.toFixed(1)}s`);
  if (p.width && p.height) bits.push(`${p.width}×${p.height}${p.fps ? `@${p.fps}` : ''}`);
  if (e.loudness?.ok) bits.push(`${e.loudness.lufs ?? '?'} LUFS / 峰值 ${e.loudness.truePeak ?? '?'} dBTP`);
  if (e.avDriftSec != null) bits.push(`音画差 ${e.avDriftSec}s`);
  const head = check.pass ? '预筛通过' : `预筛未过（${check.fails.join('；')}）`;
  return `${head}｜${bits.join(' · ')}${check.warnings?.length ? `｜注意：${check.warnings.join('；')}` : ''}`;
}
