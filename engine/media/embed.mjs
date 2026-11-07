// 把模型随口写的片子路径收成对话播放器能用的 /api/ws/file。
const VIDEO_EXT = /\.(mp4|webm|mov)(?:\b|$)/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)(?:\b|$)/i;
const AUDIO_EXT = /\.(mp3|wav|m4a)(?:\b|$)/i;

// 相对工作区路径：生成物/工程/交付（含连续创作的历史目录 workshop-out），会被收成 /api/ws/file。
const LOCAL_MEDIA_REL = /^(?:生成物|工程|workshop-out|交付)[\\/]/i;
// 本机（回环）绝对地址：老会话里存过 http://127.0.0.1:8787/api/ws/file?... 这种写法。
const LOCAL_MEDIA_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/api\/ws\/file(?:[?#]|$)/i;

// 聊天里"能不能放播放器"的唯一判据（2026-11-07）。
//
// 产品原则：远程图像/视频模型的生成物必须先下载到本地，再由窗口发出来——远端签名链接
// 几小时到几天就过期，平台也会清，直接塞进 <video> 只会得到一个永远转圈的黑框，
// 用户还以为片子坏了。所以聊天只给**本地/同源**地址放播放器，远端地址退回文本 + 链接。
//   /api/ws/file?path=…                → 允许（工作区文件服务，含 exp/sig 签名变体）
//   生成物/ 工程/ workshop-out/ 交付/  → 允许（相对工作区路径，先归一成上面的地址）
//   https://platform-outputs…          → 不允许（远端临时产物，没落盘）
//   https://example.com/x.mp4          → 不允许（示例/外链，不是本机产物）
//
// 注意边界：这条规则**只用于聊天嵌入**。影视页的直播源由 frontend/src/lib/tv.ts 直接直连
// 原始 m3u8，不走这里，也不要拿这个判据去改写直播地址（手机上转换过的地址会半天刷不出来）。
export function isLocalPlayableUrl(url) {
  const s = String(url || "").trim().replace(/^["'`<]+|[>"'`]+$/g, "");
  if (!s) return false;
  if (/^data:video\//i.test(s)) return true;          // data: 视频本身就是本地字节
  if (/^\.?\/api\/ws\/file(?:[?#]|$)/i.test(s)) return true;
  if (LOCAL_MEDIA_REL.test(s)) return true;
  return LOCAL_MEDIA_ORIGIN.test(s);
}

// 聊天里愿意播放的**视频**地址（2026-11-07）：本地/同源就归一成播放器能直接吃的地址，
// 远端临时链接（platform-outputs…）与示例外链一律返回 ""，调用方据此不生成播放块。
//   已经是 /api/ws/file 或 data: → 原样返回（保留 exp/sig）
//   生成物/工程/workshop-out/交付 相对路径、本机绝对路径 → /api/ws/file?path=…
//   回环同源签名地址 → 原样返回；其余 http(s) → ""
export function localPlayableVideoUrl(url) {
  const s = String(url || "").trim().replace(/^["'`<]+|[>"'`]+$/g, "");
  if (!s) return "";
  if (/^data:video\//i.test(s)) return s;
  if (/^\.?\/api\/ws\/file(?:[?#]|$)/i.test(s)) return s;
  const rel = toWorkspaceRel(s);
  if (rel) return workspaceFileUrl(rel);
  return /^https?:\/\//i.test(s) && isLocalPlayableUrl(s) ? s : "";
}

// 远端视频落在聊天里只能是一行提示 + 链接——绝不能生成播放块（过期后就是永远转圈的黑框）。
export const REMOTE_VIDEO_NOTE = "（远端视频未落盘，可能过期）";

// 第三方工具 / 扩展直传的 details.media 统一闸门（2026-11-07）。
// 这些 media 不经过 saveArtifact，远端签名链接以前被原样 push 进消息 → 聊天里多一个播不了的窗口。
// 现在视频必须先过 isLocalPlayableUrl；不是本地就**不生成播放块**，改成一行文字 + 原链接。
// 内置 generate_video 已经保证落盘（本地地址），走这里直接放行，不受影响。
export function gateIncomingMedia(media) {
  if (!media || typeof media !== "object" || !media.url) return { media: null, note: "" };
  if (String(media.type || "").toLowerCase() !== "video") return { media, note: "" };
  const playable = localPlayableVideoUrl(media.url);
  if (playable) return { media: playable === media.url ? media : { ...media, url: playable }, note: "" };
  return { media: null, note: `${REMOTE_VIDEO_NOTE}${String(media.url).trim()}` };
}

// Only workspace links are normalized; external hosts and version queries matter.
export function mediaDeliveryKey(url) {
  const value = String(url || '').trim();
  const rel = toWorkspaceRel(value);
  return rel ? `workspace:${rel}` : value;
}

// 工具文本可能是别的任务的协议/经验/搜索结果；路径存在不等于本轮交付。
export function explicitToolMedia(out, { id, name } = {}) {
  const media = out?.media;
  if (out?.isError || !media?.url || !['image', 'video', 'audio'].includes(media.type)) return null;
  return { ...media, source: 'tool', toolCallId: id, toolName: name };
}

export function workspaceFileUrl(p) {
  const rel = toWorkspaceRel(clipMediaPath(p));
  if (!rel) return "";
  return "/api/ws/file?path=" + encodeURIComponent(rel);
}

export function toWorkspaceRel(p) {
  let s = String(p || "").trim().replace(/^["'`<]+|[>"'`]+$/g, "");
  if (!s) return "";
  if (s.startsWith("/api/ws/file")) {
    const m = s.match(/[?&]path=([^&\s]+)/);
    if (!m) return "";
    try { return decodeURIComponent(m[1]).replace(/\\/g, "/"); } catch { return m[1]; }
  }
  s = s.replace(/^\uFEFF/, "");
  const unified = s.replace(/\//g, "\\");
  const ws = unified.match(/^[A-Za-z]:\\(?:[^\\]+\\)*(?:yuanshu-space|pi-workspace)\\(.+)$/i);
  if (ws) return ws[1].replace(/\\/g, "/");
  if (/^(生成物|工程|workshop-out|交付)[\\/]/i.test(s)) return s.replace(/\\/g, "/");
  return "";
}

export function extractPlayableMedia(text) {
  const videos = [];
  const images = [];
  const audios = [];
  const add = (bucket, url) => { if (url && !bucket.includes(url)) bucket.push(url); };
  const raw = String(text || "");
  const hits = new Set();
  for (const m of raw.matchAll(/\/api\/ws\/file\?path=[^\s)）"'<>]+/g)) hits.add(m[0].replace(/[.,;。，]+$/, ""));
  for (const m of raw.matchAll(/[A-Za-z]:\\[^\s)）"'<>]+/g)) hits.add(m[0].replace(/[.,;。，]+$/, ""));
  for (const m of raw.matchAll(/(?:生成物|工程|workshop-out|交付)[\\/][^\s)）"'<>]+/g)) hits.add(m[0].replace(/[.,;。，]+$/, ""));
  for (const m of raw.matchAll(/📎\s*交付:\s*(\S+)/g)) hits.add(m[1]);
  for (const rawHit of hits) {
    const hit = clipMediaPath(rawHit);
    const url = hit.startsWith("/api/ws/file") ? hit.split("&")[0] : workspaceFileUrl(hit);
    if (!url) continue;
    const pathPart = url.includes("path=") ? safeDecode(url.split("path=")[1]) : hit;
    if (VIDEO_EXT.test(pathPart) || VIDEO_EXT.test(hit)) add(videos, url);
    else if (IMAGE_EXT.test(pathPart) || IMAGE_EXT.test(hit)) add(images, url);
    else if (AUDIO_EXT.test(pathPart) || AUDIO_EXT.test(hit)) add(audios, url);
  }
  // 这里只负责"从正文里捞本机片子"；外链一律不进播放器（远端地址由调用方写成文本 + 链接）。
  return { videos: videos.filter(isLocalPlayableUrl), images, audios };
}

function clipMediaPath(s) {
  const m = String(s || "").match(/^(.*?\.(?:mp4|webm|mov|png|jpe?g|gif|webp|mp3|wav|m4a))/i);
  return m ? m[1] : String(s || "");
}

function safeDecode(s) {
  try { return decodeURIComponent(String(s || "")); } catch { return String(s || ""); }
}
