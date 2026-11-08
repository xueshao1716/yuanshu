// 元枢会话连续性：打断也留痕，有历史就不许装新开。
import { attachmentText, extractText } from "./session/utils.mjs";
import { imageVerificationNotice } from "./media/dimensions.mjs";
import { mediaDeliveryKey } from './media/embed.mjs';
import { IMAGE_UNAVAILABLE_NOTE, localizeMarkdownImagesCached, localizeMarkdownImagesDetailed } from "./media/markdown-images.mjs";

export function resumePersistenceState(entries = [], message, resume = false) {
  const state = { userPersisted: false, toolCallIds: new Set(), toolResultIds: new Set(), mediaKeys: new Set() };
  if (!resume) return state;
  const messages = entries.filter(e => e?.type === 'message').map(e => e.message);
  const lastUser = messages.findLastIndex(m => m?.role === 'user');
  if (lastUser < 0 || extractText(messages[lastUser].content) !== message) return state;
  state.userPersisted = true;
  for (const item of messages.slice(lastUser + 1)) {
    if (item?.role === 'assistant') {
      // SDK-safe persistence encodes image, audio and video as markdown. Only
      // this saved user turn is evidence of delivery, never arbitrary tool text.
      for (const match of extractText(item.content).matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
        state.mediaKeys.add(mediaDeliveryKey(match[1]));
      }
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (['image', 'audio', 'video'].includes(block?.type) && block.url) state.mediaKeys.add(mediaDeliveryKey(block.url));
      }
    }
    if (item?.role === 'assistant' && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === 'toolCall' && block.id) state.toolCallIds.add(String(block.id));
      }
    }
    if (item?.role === 'toolResult' && item.toolCallId) state.toolResultIds.add(String(item.toolCallId));
  }
  return state;
}

export function sessionContinuityNote(hist = []) {
  const n = Array.isArray(hist) ? hist.length : 0;
  if (n > 0) return "【本会话】上面是本会话已有对话，不是新开的。接着做，做完汇报。";
  return "【本会话】这是本会话第一条。跨会话细节看记忆目录或 read 记忆.md，不要 bash 扫盘，也不要说记忆系统坏了。";
}

export function coachSearchRound(name, count, out = {}) {
  const next = { ...out, text: String(out?.text || ""), isError: out?.isError === true };
  if (name !== "web_search" || Number(count) < 2) return next;
  if (!/不要再连搜|按判断写/.test(next.text)) {
    next.text += "\n[宿主] 搜了两轮还锁不到就按判断写，把假设写进汇报，不要再连搜。";
  }
  return next;
}

export function abortedAssistantText(result) {
  const t = String(result?.text || "").trim();
  return t || "（本轮已停止）";
}

export function persistYuanshuUser(sm, message) {
  if (!sm?.appendMessage) return;
  sm.appendMessage({ role: "user", content: [{ type: "text", text: String(message || "") }] });
}

// 会话里的 assistant 消息会被 pi SDK **原样重放**（切模型、或 agent 重建时读整段历史）。
// 而 SDK 的 token 估算器只认 text / thinking 两类块，其余一律当"工具调用"去读
// block.name.length（pi-ai/dist/utils/estimate.js:42）——于是 assistant 消息里只要有一个
// {type:"image",url} 块，就在**发请求之前**抛
//   TypeError: Cannot read properties of undefined (reading 'length')
// 而且这条会话此后每次重放都崩：真机上"出图交付"那条消息把整段会话带崩，
// 用户看到的是"切到 deepseek 后一句话都不说"（usage 0/0 + stopReason=error 被界面吞掉）。
//
// 所以落盘前统一做"SDK 安全化"：附件块（image/video/audio/file）改写成纯文本 markdown
// 图片；工具调用/思考块原样保留（SDK 要靠它们配 toolResult）；其它不认识的块降级成文本或丢弃。
// 注意：这**只**影响会话文件里 assistant 的 content，界面照样能看到图——
// engine/session-utils.mjs 的 extractImages 会从文本里把这些 markdown 图片再抠出来。
const SDK_SAFE_BLOCK_TYPES = new Set(["text", "thinking", "redacted_thinking", "toolCall", "tool_call", "toolResult", "tool_result", "toolUse", "tool_use"]);
const ATTACHMENT_BLOCK_TYPES = new Set(["image", "video", "audio", "file"]);

export function sdkSafeAssistantBlocks(blocks = []) {
  const list = Array.isArray(blocks) ? blocks : [{ type: "text", text: String(blocks ?? "") }];
  const out = [];
  for (const b of list) {
    if (typeof b === "string") { if (b) out.push({ type: "text", text: b }); continue; }
    if (!b || typeof b !== "object") continue;
    const type = String(b.type || "");
    if (SDK_SAFE_BLOCK_TYPES.has(type)) { out.push(b); continue; }
    if (ATTACHMENT_BLOCK_TYPES.has(type)) {
      const label = type === "image" ? "图片" : type === "video" ? "视频" : type === "audio" ? "音频" : "文件";
      const url = typeof b.url === "string" ? b.url : "";
      // 例外：带 name 的 file 块**保持原样**。估算器读的是 block.name.length，有 name 就安全，
      // 而界面靠 type:"file" 渲染文件卡片（extractFiles）——转成文本会把卡片弄丢。
      // 没有 name 的 file 块和不带 name 的图/音视频块一样会抛 TypeError，必须转文本。
      if (type === "file" && typeof b.name === "string" && b.name) { out.push(b); continue; }
      if (url) out.push({ type: "text", text: `![${label}](${url})` });
      else if (b.path || b.name) out.push({ type: "text", text: `[${label}] ${b.path || b.name}` });
      if (type === 'image' && b.verification) out.push({ type: 'text', text: imageVerificationNotice(b.verification) });
      if (type === 'image' && b.model) out.push({ type: 'text', text: `绘图模型：${b.model}${b.attempts?.length > 1 ? `；调用记录：${b.attempts.map(a => `${a.model} ${a.status || a.outcome}`).join(' → ')}` : ''}` });
      continue;   // 其余附件块绝不留在 content 里：宁可少一条附件，也不能让整段会话不可重放
    }
    if (typeof b.text === "string" && b.text) out.push({ type: "text", text: b.text });
  }
  if (!out.length) out.push({ type: "text", text: "" });
  return out;
}

// ══ 用户消息的 SDK 安全化（2026-09-18 真机事故）══════════════════════
// 与 assistant 的坑不是同一个，后果却更重：
//   pi-ai 的 openai-completions 适配器处理**用户消息**时，content 数组里只要有一块不是
//   {type:"text"}，就无条件写成 image_url：
//     url = `data:${item.mimeType};base64,${item.data}`
//   上传路由落的 {type:"file",name,path,size,mime:""} 于是变成
//     data:;base64,undefined
//   → 上游 400「You have uploaded an unsupported image」，而且这条坏消息**已经落盘**，
//     此后每一轮重放都 400，整个会话作废。
// 规矩：用户消息里只留 text 和**真图**（有 data + mimeType）；文件附件改写成一行文本标记，
//   界面靠 session-utils.extractFiles 解析标记，文件卡片照旧。
export function sdkSafeUserBlocks(blocks = []) {
  const list = Array.isArray(blocks) ? blocks : [{ type: "text", text: String(blocks ?? "") }];
  const out = [];
  for (const b of list) {
    if (typeof b === "string") { if (b) out.push({ type: "text", text: b }); continue; }
    if (!b || typeof b !== "object") continue;
    const type = String(b.type || "");
    if (type === "text") { if (typeof b.text === "string" && b.text) out.push(b); continue; }
    if (type === "file") {
      const name = String(b.name || (b.path ? String(b.path).split(/[\\/]/).pop() : ""));
      if (name || b.path) out.push({ type: "text", text: attachmentText({ ...b, name }) });
      continue;
    }
    if (type === "image") {
      // 真图（有 base64 + mimeType）是 SDK 唯一支持的附件形态，原样保留
      if (typeof b.data === "string" && b.data && typeof b.mimeType === "string" && b.mimeType) { out.push(b); continue; }
      if (typeof b.url === "string" && b.url) { out.push({ type: "text", text: `![图片](${b.url})` }); continue; }
      continue;
    }
    if (type === "video" || type === "audio") {
      const label = type === "video" ? "视频" : "音频";
      const where = b.url || b.path || b.name || "";
      if (where) out.push({ type: "text", text: `[${label}] ${where}` });
      continue;
    }
    if (typeof b.text === "string" && b.text) out.push({ type: "text", text: b.text });
  }
  if (!out.length) out.push({ type: "text", text: "" });
  return out;
}

// 同步兜底：任何直接调用 persistYuanshuAssistant 的路径，也不能把远端 Markdown 图写进会话。
// 这里只查归档缓存（不下载）：命中本地→换地址；没命中→一行文字。
// 会下载的写路径用 persistYuanshuAssistantLocalized（先落盘再落库）。
function localizeBlocksForPersistence(blocks) {
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b?.type === "text" && typeof b.text === "string" && b.text.indexOf("![") >= 0) {
      try {
        const next = localizeMarkdownImagesCached(b.text);
        out.push(next === b.text ? b : { ...b, text: next });
      } catch { out.push(b); }
    } else out.push(b);
  }
  return out;
}

export function persistYuanshuAssistant(sm, text, mediaItems = [], metadata = {}) {
  if (!sm?.appendMessage) return;
  const body = typeof text === "string" ? [{ type: "text", text }] : text;
  const content = localizeBlocksForPersistence(sdkSafeAssistantBlocks(Array.isArray(body) ? body : [{ type: "text", text: String(text || "") }]));
  // 2026-10-24：usage 一并落盘——统计/成本面板此前看不到自己循环的花费
  const { model, requestedModel, switchedModel, engine, usage } = metadata;
  sm.appendMessage({ role: "assistant", content,
    ...(model?.id ? { provider: model.provider, model: model.id } : {}),
    ...(requestedModel ? { requestedModel } : {}), ...(switchedModel ? { switchedModel } : {}), ...(engine ? { engine } : {}),
    ...(usage ? { usage } : {}) });
  void mediaItems;
}

// 落库/广播前的正文外链图归档（2026-11-08）。
// 与 extractMessages 读路径用同一个归档器：下载成功→本地地址；失败/超限→一行文字；
// 单条消息最多 3 张；任何异常都降级，绝不把远端 URL 留进新消息。
// 返回 { blocks, text, changed, localized, failed, skipped }：
//   blocks 已过 sdkSafeAssistantBlocks（附件块→markdown），可直接交给 persistYuanshuAssistant；
//   text 只是正文拼接，供需要广播纯文本的调用方使用。
export async function localizeAssistantMarkdown(text, { wsRoot = "", saveArtifact = null, now = null, maxPerMessage = 3 } = {}) {
  const list = Array.isArray(text) ? text : [{ type: "text", text: String(text ?? "") }];
  const blocks = sdkSafeAssistantBlocks(list);
  const out = [];
  const stats = { changed: false, found: 0, localized: 0, failed: 0, skipped: 0, attempted: 0 };
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string" && b.text.indexOf("![") >= 0) {
      try {
        const r = await localizeMarkdownImagesDetailed(b.text, { wsRoot, saveArtifact, now, maxPerMessage });
        if (r.text !== b.text) stats.changed = true;
        stats.found += r.found || 0;
        stats.localized += r.localized || 0;
        stats.failed += r.failed || 0;
        stats.skipped += r.skipped || 0;
        stats.attempted += r.attempted || 0;
        out.push(r.text === b.text ? b : { ...b, text: r.text });
      } catch {
        // 归档器本身不该抛；真抛了也不能把远端 URL 留在正文里。
        out.push({ ...b, text: String(b.text).replace(/!\[[^\]]*\]\(\s*<?https?:\/\/[^)\s>]+>?[^)]*\)/g, IMAGE_UNAVAILABLE_NOTE) });
        stats.changed = true;
      }
    } else {
      out.push(b);
    }
  }
  return { blocks: out, text: extractText(out), ...stats };
}

/** 本地化后再落盘；写路径统一走这个，避免新消息一开始带厂商地址。 */
export async function persistYuanshuAssistantLocalized(sm, text, mediaItems = [], metadata = {}, opts = {}) {
  const localized = await localizeAssistantMarkdown(text, opts);
  return persistYuanshuAssistant(sm, localized.blocks, mediaItems, metadata);
}

// Persist the model/tool exchange that happened after the current user turn.
// Unified chat keeps this transcript in memory, but the session file used to
// receive only the final prose. That made the next turn lose the actual
// command output (and made a resumed task look like a fresh conversation).
export function persistYuanshuToolTrace(sm, history = [], persisted = {}) {
  if (!sm?.appendMessage || !Array.isArray(history)) return;
  let userIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "user") { userIndex = i; break; }
  }
  if (userIndex < 0) return;
  const seen = new Set(persisted.toolCallIds || []);
  const persistedResults = new Set(persisted.toolResultIds || []);
  for (const message of history.slice(userIndex + 1)) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue;
    const calls = message.tool_calls.filter(c => c?.id && c?.function?.name && !seen.has(c.id));
    const blocks = [];
    if (calls.length && typeof message.content === "string" && message.content.trim()) blocks.push({ type: "text", text: message.content });
    for (const call of calls) {
      blocks.push({ type: "toolCall", id: String(call.id), name: String(call.function.name), arguments: String(call.function.arguments || "{}") });
      seen.add(call.id);
    }
    if (blocks.length) {
      try { sm.appendMessage({ role: "assistant", content: blocks, ...(message.anthropic_content ? { anthropic_content: message.anthropic_content, anthropic_model: message.anthropic_model } : {}) }); } catch {}
    }
    for (const result of history) {
      if (result?.role !== "tool" || !result.tool_call_id || !seen.has(result.tool_call_id) || persistedResults.has(result.tool_call_id)) continue;
      try {
        sm.appendMessage({ role: "toolResult", toolCallId: String(result.tool_call_id), isError: !!result.isError, content: [{ type: "text", text: String(result.content || "") }] });
        persistedResults.add(result.tool_call_id);
      } catch {}
    }
  }
}
