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

// ── 图片：本地存档是**唯一**交付路径（2026-11-08）────────────────────────
// 用户原话："聊天界面给我放的图的地址是模型平台的地址，不是我们约定的图存档本地。
// 所以刚有一个 gpt 平台的图，在一个终端可以看到，别的终端都看不到了。"
// 视频那条判据（远端就退回文字+链接）对图片还不够狠：厂商随时可能把地址关掉，
// 关了就**永远没图可看**，连"点开原链接"都救不回来。所以：
//   /api/ws/file?path=… / data:image / 生成物|工程|workshop-out|交付 相对路径 → 可交付
//   其它 http(s)（platform-outputs… 等厂商临时地址）→ 不可交付；调用方必须先
//   saveArtifact 下载进 生成物/图片/，落不下来就按失败处理（只留一行文字说明），
//   **绝不**把厂商地址当图片块发出去（也不走同源代理：代理仍依赖厂商地址活着）。
export function isLocalImageUrl(url) {
  const s = String(url || "").trim().replace(/^["'`<]+|[>"'`]+$/g, "");
  if (!s) return false;
  if (/^data:image\//i.test(s)) return true;          // data: 图片本身就是本地字节
  if (/^\.?\/api\/ws\/file(?:[?#]|$)/i.test(s)) return true;
  if (LOCAL_MEDIA_REL.test(s)) return true;
  return LOCAL_MEDIA_ORIGIN.test(s);
}

// 聊天里愿意显示的图片地址：本地/同源归一成窗口能直接加载的地址，远端一律返回 ""。
//   已经是 /api/ws/file 或 data: → 原样返回（保留 exp/sig）
//   生成物/工程/workshop-out/交付 相对路径、本机绝对路径 → /api/ws/file?path=…
//   回环同源签名地址 → 原样返回
//   其它同源相对路径（/assets/x.png、blob:…）→ 原样返回，它们不依赖厂商
//   其余 http(s)（厂商临时地址）→ ""（调用方必须落盘后再发）
export function localImageUrl(url) {
  const s = String(url || "").trim().replace(/^["'`<]+|[>"'`]+$/g, "");
  if (!s) return "";
  if (/^data:image\//i.test(s)) return s;
  if (/^\.?\/api\/ws\/file(?:[?#]|$)/i.test(s)) return s;
  const rel = toWorkspaceRel(s);
  if (rel) return workspaceFileUrl(rel);
  if (/^https?:\/\//i.test(s)) return isLocalImageUrl(s) ? s : "";
  return s;   // 同源相对路径：不是厂商地址，照原样
}

// 厂商/外站图片地址（需要先落盘）：是 http(s) 且不是本机同源。
export function isRemoteImageUrl(url) {
  const s = String(url || "").trim().replace(/^["'`<]+|[>"'`]+$/g, "");
  return /^https?:\/\//i.test(s) && !isLocalImageUrl(s);
}

// "未落盘"这条状态只用于统计/排查（unlocalized:true），**不是**可显示状态：
// 图片没进本地存档就不进聊天，用户看到的应该是"这张图没存下来"，而不是一个随时会裂的图。
export const REMOTE_IMAGE_NOTE = "图片未落盘，原图在厂商侧可能随时失效";
export function imageUnlocalizedNote(reason = "") {
  const why = String(reason || "").trim();
  return `有一张${why ? `图没能存到本地（${why}）` : "图没能存到本地"}，已不展示；${REMOTE_IMAGE_NOTE}。`;
}

// 第三方工具 / 扩展直传的 details.media 统一闸门（2026-11-07，2026-11-08 扩到图片）。
// 这些 media 不经过 saveArtifact，远端签名链接以前被原样 push 进消息 → 聊天里多一个播不了的窗口。
//   · video：必须先过 isLocalPlayableUrl；不是本地就**不生成播放块**，改一行文字 + 原链接；
//   · image：本地/data: 直接放行；远端 http(s) 先 saveArtifact 落盘，成功改本地地址，
//     失败就**这一条不进聊天**（返回 media:null + 一行说明，unlocalized:true 供统计排查），
//     绝不把厂商 URL 塞进图片块，也不走代理（代理同样依赖厂商地址活着）。
// 内置 generate_image / generate_video 已经保证落盘（本地地址），走这里直接放行。
// 注意：图片这条分支要下载，所以整个闸门是 async；不传 saveArtifact 时按"没有落盘实现"处理。
export async function gateIncomingMedia(media, { saveArtifact = null } = {}) {
  if (!media || typeof media !== "object" || !media.url) return { media: null, note: "", unlocalized: false };
  const type = String(media.type || "").toLowerCase();
  if (type === "video") {
    const playable = localPlayableVideoUrl(media.url);
    if (playable) return { media: playable === media.url ? media : { ...media, url: playable }, note: "", unlocalized: false };
    return { media: null, note: `${REMOTE_VIDEO_NOTE}${String(media.url).trim()}`, unlocalized: false };
  }
  if (type !== "image") return { media, note: "", unlocalized: false };
  const local = localImageUrl(media.url);
  if (local) return { media: local === media.url ? media : { ...media, url: local }, note: "", unlocalized: false };
  const remote = String(media.url).trim();
  if (!isRemoteImageUrl(remote)) return { media: null, note: "", unlocalized: false };
  if (typeof saveArtifact === "function") {
    try {
      const saved = await saveArtifact({ type: "image", url: remote, prompt: String(media.prompt || "") });
      if (saved?.local && saved.url) return { media: { ...media, url: saved.url, localized: true }, note: "", unlocalized: false };
      console.log(`[元枢] 图片未落盘，不交付: ${saved?.reason || "下载失败"}`);
      return { media: null, note: imageUnlocalizedNote(saved?.reason || "下载失败"), unlocalized: true };
    } catch (e) {
      console.log(`[元枢] 图片未落盘，不交付: ${String(e?.message || e).slice(0, 120)}`);
      return { media: null, note: imageUnlocalizedNote(String(e?.message || e).slice(0, 120)), unlocalized: true };
    }
  }
  console.log("[元枢] 图片未落盘，不交付: 没有落盘实现");
  return { media: null, note: imageUnlocalizedNote("没有落盘实现"), unlocalized: true };
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
