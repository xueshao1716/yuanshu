// 元枢会话连续性：打断也留痕，有历史就不许装新开。

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
      continue;   // 其余附件块绝不留在 content 里：宁可少一条附件，也不能让整段会话不可重放
    }
    if (typeof b.text === "string" && b.text) out.push({ type: "text", text: b.text });
  }
  if (!out.length) out.push({ type: "text", text: "" });
  return out;
}

export function persistYuanshuAssistant(sm, text, mediaItems = []) {
  if (!sm?.appendMessage) return;
  const body = typeof text === "string" ? [{ type: "text", text }] : text;
  const content = sdkSafeAssistantBlocks(Array.isArray(body) ? body : [{ type: "text", text: String(text || "") }]);
  sm.appendMessage({ role: "assistant", content });
  void mediaItems;
}

// Persist the model/tool exchange that happened after the current user turn.
// Unified chat keeps this transcript in memory, but the session file used to
// receive only the final prose. That made the next turn lose the actual
// command output (and made a resumed task look like a fresh conversation).
export function persistYuanshuToolTrace(sm, history = []) {
  if (!sm?.appendMessage || !Array.isArray(history)) return;
  let userIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "user") { userIndex = i; break; }
  }
  if (userIndex < 0) return;
  const seen = new Set();
  const persistedResults = new Set();
  for (const message of history.slice(userIndex + 1)) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue;
    const calls = message.tool_calls.filter(c => c?.id && c?.function?.name);
    if (!calls.length || calls.some(c => seen.has(c.id))) continue;
    const blocks = [];
    if (typeof message.content === "string" && message.content.trim()) blocks.push({ type: "text", text: message.content });
    for (const call of calls) {
      blocks.push({ type: "toolCall", id: String(call.id), name: String(call.function.name), arguments: String(call.function.arguments || "{}") });
      seen.add(call.id);
    }
    try { sm.appendMessage({ role: "assistant", content: blocks }); } catch {}
    for (const result of history) {
      if (result?.role !== "tool" || !result.tool_call_id || !seen.has(result.tool_call_id) || persistedResults.has(result.tool_call_id)) continue;
      try {
        sm.appendMessage({ role: "toolResult", toolCallId: String(result.tool_call_id), isError: !!result.isError, content: [{ type: "text", text: String(result.content || "") }] });
        persistedResults.add(result.tool_call_id);
      } catch {}
    }
  }
}
