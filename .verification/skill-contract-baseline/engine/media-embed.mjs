// 把模型随口写的片子路径收成对话播放器能用的 /api/ws/file。
const VIDEO_EXT = /\.(mp4|webm|mov)(?:\b|$)/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)(?:\b|$)/i;
const AUDIO_EXT = /\.(mp3|wav|m4a)(?:\b|$)/i;

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
  const ws = unified.match(/^[A-Za-z]:\\(?:[^\\]+\\)*pi-workspace\\(.+)$/i);
  if (ws) return ws[1].replace(/\\/g, "/");
  if (/^(生成物|工程|workshop-out)[\\/]/i.test(s)) return s.replace(/\\/g, "/");
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
  for (const m of raw.matchAll(/(?:生成物|工程|workshop-out)[\\/][^\s)）"'<>]+/g)) hits.add(m[0].replace(/[.,;。，]+$/, ""));
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
  return { videos, images, audios };
}

function clipMediaPath(s) {
  const m = String(s || "").match(/^(.*?\.(?:mp4|webm|mov|png|jpe?g|gif|webp|mp3|wav|m4a))/i);
  return m ? m[1] : String(s || "");
}

function safeDecode(s) {
  try { return decodeURIComponent(String(s || "")); } catch { return String(s || ""); }
}
