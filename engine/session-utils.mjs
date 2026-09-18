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

// ── 附件标记（2026-09-18）─────────────────────────────────────────────
// 真机事故：上传任意文件后，该会话**此后每一轮**都 400
//   Upstream request failed: .messages[11]: You have uploaded an unsupported image.
// 根因不在元枢的组装层，而在兼容适配器 SDK 的 provider 适配：
//   @earendil-works/pi-ai/dist/api/openai-completions.js 对**用户消息**的 content 数组
//   只认 type==="text"，其余（file / image 无 data / …）一律写成
//   {type:"image_url", image_url:{url:`data:${item.mimeType};base64,${item.data}`}}
//   → "data:;base64,undefined" → 上游按"坏图"拒绝，而这条消息已经落盘，永久毒化整个会话。
//   （纯文本模型看不到：transform-messages 的 downgradeUnsupportedImages 会把图降级成占位文本，
//     所以只有 input 含 image 的模型才复现——复现脚本见 D:\pi-workspace\tmp\repro-file-poison.mjs）
// 结论：用户消息里**只允许 text / 真图(data+mimeType)**。文件附件改用一行文本标记承载，
//   markdown/JSONL 里可读、SDK 安全；界面靠 extractFiles 解析这行照样渲染文件卡片。
export const ATTACHMENT_MARK = "📎 附件:";
const ATTACHMENT_LINE = /^📎 附件:\s*name="([^"]*)"\s+path="([^"]*)"(?:\s+size=(\d+))?(?:\s+mime="([^"]*)")?/gm;

// 生成一行附件标记（name/path/mime 里的引号统一替换，保证可被上面的正则精确还原）
export function attachmentText(block = {}) {
  const clean = (v) => String(v ?? "").replace(/"/g, "'");
  const size = Number(block.size) || 0;
  return `${ATTACHMENT_MARK} name="${clean(block.name)}" path="${clean(block.path)}" size=${size} mime="${clean(block.mime)}"`;
}

// 从文本里抠出附件（兼容旧会话的 type:"file" 块与新的文本标记两种形态）
export function filesFromText(text) {
  const s = typeof text === "string" ? text : "";
  if (!s || s.indexOf(ATTACHMENT_MARK) < 0) return [];
  const out = [];
  for (const m of s.matchAll(ATTACHMENT_LINE)) {
    if (!m[1] && !m[2]) continue;
    out.push({ name: m[1], path: m[2], size: m[3] ? Number(m[3]) : 0, mime: m[4] || "" });
  }
  return out;
}

// 给界面/摘要用的纯显示文本：附件标记由文件卡片呈现，不重复显示成文字
export function stripAttachmentMarks(text) {
  const s = typeof text === "string" ? text : "";
  if (!s || s.indexOf(ATTACHMENT_MARK) < 0) return s;
  return s.replace(ATTACHMENT_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

// 把 files 列表还原成附件标记行（模型侧重建历史用；界面侧由文件卡片呈现）
export function attachmentLines(files = []) {
  return (Array.isArray(files) ? files : [])
    .filter(f => f && (f.path || f.name))
    .map(f => attachmentText(f));
}

// 从消息 content 提取文件附件（type: file 的块 + 文本标记两种形态）
export function extractFiles(content) {
  const out = [];
  const seen = new Set();
  const push = (f) => {
    if (!f || (!f.name && !f.path)) return;
    const key = `${f.path || f.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: f.name || "", path: f.path || "", size: Number(f.size) || 0, mime: f.mime || "" });
  };
  if (typeof content === "string") { for (const f of filesFromText(content)) push(f); return out; }
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (!b) continue;
    if (b.type === "file") push({ name: b.name, path: b.path, size: b.size, mime: b.mime });
    else if (b.type === "text" || typeof b.text === "string") for (const f of filesFromText(b.text)) push(f);
  }
  return out;
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
      // 显示文本剥掉附件标记（卡片负责呈现）；模型侧由 formatSessionHistory 把 files 还原成文字
      const text = stripAttachmentMarks(extractText(m.content));
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
      // 失败也要看得见（2026-09-16）：pi 通道的失败会落成一条 content 空、stopReason=error 的记录。
      // 此前它不满足任何推送条件 → 被静默丢弃 → 用户只看到"它不说话/变傻了"。
      const stopReason = m.stopReason || null;
      const error = stopReason === "error"
        ? String(m.errorMessage || m.error || "本轮失败（未给出原因）")
        : stopReason === "aborted" && !text ? "本轮已停止（没有产出内容）" : "";
      if (text || files.length || images.length || videos.length || audios.length || tools.length || think || error) out.push({ role: "assistant", text, files, images, videos, audios, tools, think, error, stopReason, ts: e.timestamp, id: e.id });
    }
  }
  return out;
}
