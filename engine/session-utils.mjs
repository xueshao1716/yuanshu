// ══ 会话解析纯函数（2026-08-19 拆模块：从 server.mjs 抽出）══
// extractMessages / extractText / extractImages / extractFiles —— 无 server 内部依赖，可单测可复用。
import { extractPlayableMedia } from "./media-embed.mjs";

// 从消息 content 提取文本（type: text 的块）
export function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === "text").map(b => b.text || "").join("");
  }
  return "";
}

// 从消息 content 提取图片附件（type: image 的块）
// 旁路出图落的是 url；会话里 read 出来的图仍可能是 data + mimeType。base64 过大（>2.5MB）省略。
//
// 2026-09-16：assistant 消息里的附件块一律在落盘前改写成 markdown 图片
// （见 engine/yuanshu-session.mjs 的 sdkSafeAssistantBlocks：附件块会让 pi SDK 重放历史时
// 抛 TypeError，整段会话不可用）。所以这里必须**同时**认文本里的 markdown 图片，
// 否则"修好了重放"就会变成"界面上的图没了"。
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

function imagesFromText(text) {
  const s = typeof text === "string" ? text : "";
  if (!s || s.indexOf("![") < 0) return [];
  const out = [];
  for (const m of s.matchAll(MARKDOWN_IMAGE)) if (m[1]) out.push({ url: m[1] });
  return out;
}

export function extractImages(content) {
  if (typeof content === "string") return imagesFromText(content);
  if (!Array.isArray(content)) return [];
  const out = [];
  const seen = new Set();
  const push = (img) => {
    const key = img.url || `${img.mimeType || ""}:${String(img.data || "").slice(0, 32)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(img);
  };
  for (const b of content) {
    if (!b) continue;
    if (b.type === "image") {
      if (typeof b.url === "string" && b.url) push({ url: b.url });
      else if (b.data && b.mimeType && String(b.data).length <= 2.5 * 1024 * 1024) push({ data: b.data, mimeType: b.mimeType });
      continue;
    }
    // 文本块里的 markdown 图片（落盘改写后的形态）
    if (b.type === "text") for (const img of imagesFromText(b.text)) push(img);
  }
  return out;
}

export function imageSrc(img) {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (img.url) return img.url;
  if (img.data && img.mimeType) return String(img.data).startsWith("data:") ? img.data : `data:${img.mimeType};base64,${img.data}`;
  return "";
}

// 从消息 content 提取文件附件（type: file 的块）
export function extractFiles(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(b => b.type === "file").map(b => ({ name: b.name, path: b.path, size: b.size, mime: b.mime }));
}

export function extractVideos(content) {
  const urls = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === "video" && typeof b.url === "string" && b.url) urls.push(b.url);
    }
  }
  const scraped = extractPlayableMedia(typeof content === "string" ? content : extractText(content));
  for (const u of scraped.videos) if (!urls.includes(u)) urls.push(u);
  return urls;
}

export function extractAudios(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(b => b && b.type === "audio" && typeof b.url === "string" && b.url).map(b => b.url);
}

export function resolveLeafId(entries, leafId) {
  const ids = new Set((entries || []).filter(e => e?.type === "message" && e.id).map(e => e.id));
  if (leafId && ids.has(leafId)) return leafId;
  for (let i = (entries || []).length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "message" && e.id) return e.id;
  }
  return null;
}

export function windowMessages(messages, tail) {
  const list = Array.isArray(messages) ? messages : [];
  const n = Number(tail);
  if (!Number.isFinite(n) || n <= 0 || list.length <= n) {
    return { messages: list, truncated: false, total: list.length };
  }
  return { messages: list.slice(-n), truncated: true, total: list.length };
}

// 从会话 entries 中提取消息（供历史渲染；指定 leafId 时只返回该分支路径上的消息）
export function extractMessages(entries, leafId) {
  // 若指定 leafId：只返回该分支路径上的消息（沿 parentId 回溯）
  const byId = new Map(entries.filter(e => e.id).map(e => [e.id, e]));
  const pathIds = new Set();
  if (leafId && byId.has(leafId)) {
    let cur = byId.get(leafId);
    while (cur) { pathIds.add(cur.id); cur = cur.parentId && byId.get(cur.parentId) ? byId.get(cur.parentId) : null; }
  }
  // 第一遍：收集 toolResult（可能出现在 assistant 之后）
  const toolResults = new Map();
  for (const e of entries) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    if (m.role === "toolResult" && m.toolCallId) {
      toolResults.set(m.toolCallId, { output: extractText(m.content), isError: !!m.isError });
    }
  }
  const out = [];
  for (const e of entries) {
    if (e.type !== "message") continue;
    if (leafId && !pathIds.has(e.id)) continue;
    const m = e.message;
    if (!m) continue;
    if (m.role === "user") {
      const text = extractText(m.content);
      const files = extractFiles(m.content);
      const images = extractImages(m.content).map(imageSrc).filter(Boolean);
      const videos = extractVideos(m.content);
      const audios = extractAudios(m.content);
      if (text || files.length || images.length || videos.length || audios.length) out.push({ role: "user", text, files, images, videos, audios, ts: e.timestamp, id: e.id });
    } else if (m.role === "assistant") {
      const text = extractText(m.content);
      const files = extractFiles(m.content);
      const images = extractImages(m.content).map(imageSrc).filter(Boolean);
      const videos = extractVideos(m.content);
      const audios = extractAudios(m.content);
      const tools = [];
      let think = "";
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "toolCall" && b.id && b.name) {
            const r = toolResults.get(b.id) || {};
            tools.push({ id: b.id, name: b.name, args: b.arguments || null, output: r.output || "", isError: !!r.isError });
          } else if (b.type === "thinking" && (b.thinking || b.text)) {
            think += (b.thinking || b.text || "");
          }
        }
      }
      if (text || files.length || images.length || videos.length || audios.length || tools.length || think) out.push({ role: "assistant", text, files, images, videos, audios, tools, think, ts: e.timestamp, id: e.id });
    }
  }
  return out;
}
