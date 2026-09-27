// engine/media-inline.mjs —— 把「元枢自己的文件引用」变成上游能接受的 media
//
// 背景（2026-09-15 实测，不是推测）：连续创作把角色定妆照作为 images[] 传给 Agnes 视频接口，
// 值却是元枢自己的**相对地址** `/api/ws/file?path=...`（见 story-orchestrator 的 run.referenceImages）。
// Agnes 只接受**公网 http(s) URL 或 base64 data URI**，于是每一次带参考图的任务都以
//   视频任务创建失败 400: {"code":"invalid_request","message":"media must be a public http(s) URL
//   or base64 data. Local file paths are not supported; upload the file first ..."}
// 结束。真实项目「制作台验收」里 5 次视频运行全是这一条；同一模型在没带参考图时反而能出片。
//
// 为什么内联 base64 而不是拼一个公网地址：元枢是本地部署，上游抓不到 127.0.0.1；
// 而公网隧道是本地系统管理的、随时可能不在（而且模型被明令禁止碰隧道）。
// 读文件内联是唯一不依赖外部可达性的做法，也正是上游在错误信息里给出的选项之一。
import fs from 'node:fs';
import path from 'node:path';
import { localPathFromArtifactUrl } from './story-film.mjs';

// 视频创建体里所有承载 media 的字段（与 video-request.mjs 的转发清单一一对应）
export const MEDIA_KEYS = ['image', 'first_frame', 'last_frame', 'images', 'audios', 'videos'];
// 单文件内联上限。base64 会再涨 1/3，8MB 原文件 ≈ 10.7MB 请求体——再大就不该塞进一次同步请求了。
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
};

export function mimeFor(file) {
  return MIME[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

// 上游本来就能直接用的形式：data URI 或公网 http(s) 地址。
// 注意 `http://127.0.0.1/...` 也算 http(s)，但上游抓不到——那种情况由调用方负责，
// 这里不装作能判断"公网"（元枢自己产出的地址从来不是 127.0.0.1 形式，本模块不引入猜测）。
export function isDirectMedia(value) {
  const v = String(value ?? '');
  return /^data:/i.test(v) || /^https?:\/\//i.test(v);
}

// 把任意形态的引用解析成本地绝对路径：元枢的文件地址、裸的绝对路径、相对路径。
//
// 两条刻意写死的拒绝规则（都不是理论问题，是探针里真踩到的）：
//  - `wsRoot` 为空时**直接放弃**：story-film 的 withinRoot 在空 wsRoot 下会放行任意路径，
//    于是 `/api/ws/file?path=x` 会被按进程 CWD 解析并可能读到工作区外的文件。
//    宁可报"解析不到"，也不赌一个不该读的文件。
//  - 解不出来的 URL 形态值**不当作相对文件名**：`path.resolve(wsRoot, '/api/ws/file?...')`
//    会拼出 `<wsRoot>\api\ws\file?...` 这种荒谬路径，报错还会说成"文件不存在"，误导排查方向。
const URLISH = /^\/api\//i;

export function resolveLocalMedia(value, wsRoot = '') {
  const v = String(value ?? '').trim();
  if (!v) return '';
  const urlish = URLISH.test(v);
  if (!urlish && path.isAbsolute(v)) return v;
  if (!wsRoot) return '';
  const fromUrl = localPathFromArtifactUrl(v, wsRoot);
  if (fromUrl) return fromUrl;
  if (urlish || v.startsWith('/') || v.startsWith('\\')) return '';
  return path.resolve(wsRoot, v);
}

// 单项落地。返回 { value, note }：成功时 value 是可直接上送的字符串，
// 失败时 value 为空串、note 是**给人看的原因**（调用方必须把它显示出来，不能吞掉）。
export function materializeMedia(value, { wsRoot = '', maxBytes = MEDIA_MAX_BYTES, fsMod = fs } = {}) {
  const raw = String(value ?? '');
  if (!raw) return { value: '', note: '' };
  if (isDirectMedia(raw)) return { value: raw, note: '' };
  const file = resolveLocalMedia(raw, wsRoot);
  if (!file) return { value: '', note: `参考文件地址解析不到本地路径：${raw.slice(0, 120)}` };
  let size = 0;
  try { size = fsMod.statSync(file).size; } catch { return { value: '', note: `参考文件不存在或读不到：${path.basename(file)}` }; }
  if (!size) return { value: '', note: `参考文件是空文件：${path.basename(file)}` };
  if (size > maxBytes) {
    return { value: '', note: `参考文件 ${(size / 1048576).toFixed(1)}MB 超过 ${Math.round(maxBytes / 1048576)}MB 内联上限，请先压缩或换一张更小的参考图：${path.basename(file)}` };
  }
  try {
    const buf = fsMod.readFileSync(file);
    return { value: `data:${mimeFor(file)};base64,${buf.toString('base64')}`, note: '' };
  } catch (e) {
    return { value: '', note: `参考文件读取失败：${String(e?.message || e).slice(0, 120)}` };
  }
}

// 把整个创建体里的 media 字段逐项落地。
// 落不下来的项**从请求里摘掉并留下原因**，而不是：
//   a) 装作成功把相对地址发出去（上游 400，用户只看到一个英文报错）；
//   b) 静默发纯文本（等于把"带参考图"悄悄降级成"没带"，用户以为锁定了人物）。
// 摘掉之后 mode 也要跟着修正——不能给上游发一个没有 media 的 reference/keyframe 请求。
export function materializeVideoBody(body = {}, { wsRoot = '', maxBytes = MEDIA_MAX_BYTES, fsMod = fs } = {}) {
  const next = { ...(body && typeof body === 'object' ? body : {}) };
  const notes = [];
  for (const key of MEDIA_KEYS) {
    const current = next[key];
    if (current == null || current === '') continue;
    const wasArray = Array.isArray(current);
    const kept = [];
    for (const item of (wasArray ? current : [current])) {
      const r = materializeMedia(item, { wsRoot, maxBytes, fsMod });
      if (r.value) kept.push(r.value);
      else if (r.note) notes.push(r.note);
    }
    if (!kept.length) { delete next[key]; continue; }
    next[key] = wasArray ? kept : kept[0];
  }
  const has = k => (Array.isArray(next[k]) ? next[k].length > 0 : Boolean(next[k]));
  if (/^reference$/i.test(String(next.mode || '')) && !has('images') && !has('videos') && !has('audios')) next.mode = 'text';
  if (/^keyframe$/i.test(String(next.mode || '')) && !has('first_frame') && !has('last_frame')) next.mode = 'text';
  return { body: next, notes };
}
