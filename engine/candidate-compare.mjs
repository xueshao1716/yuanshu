// ===== candidate-compare.mjs —— 候选对比 + 退化回退（2026-11-01）=====
//
// 来源：NVIDIA GATOR 的做法——生成打底，智能体只做局部精修，
// **每做一步都在同一条件下对比原始与候选，退化就回退**。
//
// 我们以前只有"拦截"（交付门判 RED 不许说完成），没有"回退"。
// 这个模块补上：给定基线与候选，量出客观指标，退化了就说 rollback。
//
// 支持三类产物：
//   image: PNG（8bit RGB/RGBA、非隔行）→ 尺寸 / 亮度均值 / 对比度 / 边缘密度
//   html : 结构行数、关键标签数量、外链数量
//   code : 行数、导出符号、被删掉的导出
import fs from "node:fs";
import zlib from "node:zlib";
import { appendEvent } from "./evolution/index.mjs";

// ── PNG 解码（够用就好：8bit、颜色类型 2/6、非隔行）──
export function pngInfo(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 33 || b[0] !== 0x89 || b.toString("latin1", 1, 4) !== "PNG") return null;
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const bitDepth = b[24];
  const colorType = b[25];
  const interlace = b[28];
  // 收集 IDAT
  const parts = [];
  let off = 8;
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("latin1", off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === "IDAT") parts.push(data);
    if (type === "IEND") break;
    off += 12 + len;
  }
  return { w, h, bitDepth, colorType, interlace, idat: Buffer.concat(parts) };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 解码成 RGB 像素数组（只支持 8bit、非隔行、颜色类型 2/6）。 */
export function decodePngRgb(buf) {
  const info = pngInfo(buf);
  if (!info) return null;
  if (info.bitDepth !== 8 || info.interlace !== 0 || ![2, 6].includes(info.colorType)) return null;
  const channels = info.colorType === 6 ? 4 : 3;
  const stride = info.w * channels;
  let raw;
  try { raw = zlib.inflateSync(info.idat) } catch { return null }
  if (raw.length < (stride + 1) * info.h) return null;
  const out = Buffer.alloc(info.w * info.h * 3);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < info.h; y += 1) {
    const filter = raw[pos]; pos += 1;
    const line = Buffer.from(raw.subarray(pos, pos + stride)); pos += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 0xff;
      else if (filter === 2) line[x] = (line[x] + b) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) line[x] = (line[x] + paeth(a, b, c)) & 0xff;
    }
    for (let x = 0; x < info.w; x += 1) {
      const si = x * channels;
      const di = (y * info.w + x) * 3;
      out[di] = line[si]; out[di + 1] = line[si + 1]; out[di + 2] = line[si + 2];
    }
    prev = line;
  }
  return { w: info.w, h: info.h, rgb: out };
}

/** 图片指标：尺寸、亮度均值、对比度（std）、边缘密度。 */
export function imageMetrics(buf) {
  const decoded = decodePngRgb(buf);
  if (!decoded) {
    const info = pngInfo(buf);
    return info ? { ok: true, partial: true, w: info.w, h: info.h, bytes: buf.length } : { ok: false, error: "不是可解析的 PNG" };
  }
  const { w, h, rgb } = decoded;
  let sum = 0, sum2 = 0, edges = 0;
  const n = w * h;
  for (let i = 0; i < n; i += 1) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += luma; sum2 += luma * luma;
    if (i % w !== 0) {
      const prevIdx = (i - 1) * 3;
      const prevLuma = 0.299 * rgb[prevIdx] + 0.587 * rgb[prevIdx + 1] + 0.114 * rgb[prevIdx + 2];
      if (Math.abs(luma - prevLuma) > 24) edges += 1;
    }
  }
  const mean = sum / n;
  const variance = Math.max(0, sum2 / n - mean * mean);
  return { ok: true, w, h, bytes: buf.length, mean: Number(mean.toFixed(2)), std: Number(Math.sqrt(variance).toFixed(2)), edgeDensity: Number((edges / n).toFixed(4)) };
}

/** HTML 结构指标。 */
export function htmlMetrics(text) {
  const s = String(text || "");
  const tags = (re) => (s.match(re) || []).length;
  return {
    ok: true, bytes: Buffer.byteLength(s, "utf8"), lines: s.split(/\r?\n/).length,
    imgs: tags(/<img\b/gi), scripts: tags(/<script\b/gi), links: tags(/<a\b/gi),
    external: tags(/https?:\/\//gi),
  };
}

/** 代码指标：行数 + 导出符号。 */
export function codeMetrics(text) {
  const s = String(text || "");
  const exports = [...s.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]);
  return { ok: true, bytes: Buffer.byteLength(s, "utf8"), lines: s.split(/\r?\n/).length, exports: [...new Set(exports)].sort() };
}

export function metricsOf(kind, input) {
  if (kind === "image") {
    const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(String(input));
    return imageMetrics(buf);
  }
  const text = typeof input === "string" && fs.existsSync(input) ? fs.readFileSync(String(input), "utf8") : String(input || "");
  return kind === "html" ? htmlMetrics(text) : codeMetrics(text);
}

/**
 * 对比基线 vs 候选。
 * @param {{kind:'image'|'html'|'code', baseline:any, candidate:any, thresholds?:object}} opts
 * @returns {{verdict:'keep'|'rollback', degraded:string[], improved:string[], baseline:object, candidate:object}}
 */
export function compareCandidates({ kind = "image", baseline, candidate, thresholds = {} } = {}) {
  const base = metricsOf(kind, baseline);
  const cand = metricsOf(kind, candidate);
  if (!base.ok || !cand.ok) {
    return { verdict: "rollback", degraded: ["无法度量（基线或候选不可解析）"], improved: [], baseline: base, candidate: cand };
  }
  const degraded = [];
  const improved = [];

  if (kind === "image") {
    const minStd = thresholds.minStd ?? 20;          // 对比度不能太低（糊成一片）
    const maxEdgeDrop = thresholds.maxEdgeDrop ?? 0.35; // 边缘密度跌幅上限（细节丢失）
    const minBytesRatio = thresholds.minBytesRatio ?? 0.5; // 体积骤降通常意味着掉细节
    if (cand.std < minStd && cand.std < base.std) degraded.push(`对比度太低（${cand.std} < ${minStd}）`);
    else if (cand.std > base.std * 1.05) improved.push(`对比度提升 ${base.std} → ${cand.std}`);
    if (base.edgeDensity > 0 && (base.edgeDensity - cand.edgeDensity) / base.edgeDensity > maxEdgeDrop) {
      degraded.push(`细节减少（边缘密度 ${base.edgeDensity} → ${cand.edgeDensity}）`);
    } else if (cand.edgeDensity > base.edgeDensity * 1.05) improved.push(`细节增加 ${base.edgeDensity} → ${cand.edgeDensity}`);
    if (cand.bytes < base.bytes * minBytesRatio) degraded.push(`文件体积骤降 ${base.bytes} → ${cand.bytes}`);
    if (cand.w !== base.w || cand.h !== base.h) degraded.push(`尺寸变了 ${base.w}x${base.h} → ${cand.w}x${cand.h}`);
  } else if (kind === "html") {
    if (cand.bytes < base.bytes * (thresholds.minBytesRatio ?? 0.6)) degraded.push(`体积骤降 ${base.bytes} → ${cand.bytes}`);
    if (cand.imgs < base.imgs) degraded.push(`图片引用减少 ${base.imgs} → ${cand.imgs}`);
    if (cand.scripts < base.scripts) degraded.push(`脚本块减少 ${base.scripts} → ${cand.scripts}`);
    if (cand.external > base.external) degraded.push(`外链变多 ${base.external} → ${cand.external}`);
    if (cand.bytes > base.bytes * 1.1) improved.push(`内容增补 ${base.bytes} → ${cand.bytes}`);
  } else {
    if (cand.bytes < base.bytes * (thresholds.minBytesRatio ?? 0.5)) degraded.push(`代码量骤降 ${base.bytes} → ${cand.bytes}`);
    const lost = (base.exports || []).filter((e) => !(cand.exports || []).includes(e));
    if (lost.length) degraded.push(`导出被删：${lost.join("、")}`);
    if ((cand.exports || []).length > (base.exports || []).length) improved.push("新增导出");
  }

  return { verdict: degraded.length ? "rollback" : "keep", degraded, improved, baseline: base, candidate: cand };
}

/**
 * 交付件名字归一：去掉版本/终稿/副本/日期这类后缀，让「主图」「主图-终版」「主图 v2」能配上。
 * 只去尾部标记，不动主体词。
 */
export function normalizeArtifactName(name) {
  let n = String(name || "").trim();
  if (!n) return "";
  const SUFFIX = /(?:[-_·\s]*(?:v\d+|ver\d*|version\d*|final\d*|终版|定稿|最终版?|最终|副本|copy\d*|草稿|draft\d*|\(\d+\)|（\d+）|\d{6,8}|\d{4}-\d{2}-\d{2}))+$/i;
  for (let i = 0; i < 3; i += 1) {
    const next = n.replace(SUFFIX, "").trim();
    if (next === n || !next) break;
    n = next;
  }
  return n.toLowerCase();
}

/** 落台账（给事务台/复盘用）。 */
export function recordCompare(wsRoot, row) {
  try {
    const file = `${String(wsRoot || ".").replace(/[\\/]+$/, "")}/记忆/运行时/候选对比.jsonl`;
    fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...row }) + "\n", "utf8");
    // 2026-11-02：同时进统一事件流，供能力画像统计回退率
    try { appendEvent(wsRoot, { kind: "compare", target: row.kind === "image" ? "image" : row.kind, targetId: String(row.candidate || "").split(/[\\/]/).pop() || "", verdict: String(row.verdict || ""), by: String(row.by || "compare"), meta: { degraded: row.degraded || [] } }) } catch {}
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}
