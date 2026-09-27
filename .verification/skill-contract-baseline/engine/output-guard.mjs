// ══ 输出质量守卫（Output Guard）══
// 理念：模型不可靠是默认假设（借鉴 dsh repeat-tool-reminder / llm-retry 插件设计）。
// 统一检测四类模型输出异常，供调用方（handleChat / handleUnifiedChat）自动降级重试：
//   1. empty      — 空回复（无任何正文）
//   2. think-only — 正文全在思考里（正文空、think 有料）
//   3. repeat     — 复读（与上一条完整回复字节级相同 = repetition loop）
//   4. none       — 正常
// 纯判定模块：不依赖 server.mjs 内部符号；状态（lastReplyMap）本模块持有；
// 重试执行（换模型/直调/播报）由调用方完成。

import fs from "node:fs";

const lastReplyMap = new Map(); // sessionKey → 归一化后的上次完整回复

// 会话文件读取依赖（由 server.mjs 注入，避免本模块依赖 server 内部符号）
let _readEntriesFromFile = null;
let _extractText = null;
export function bindOutputGuardDeps({ readEntriesFromFile, extractText }) {
  _readEntriesFromFile = readEntriesFromFile;
  _extractText = extractText;
}
function readEntriesFromFile(file) { return _readEntriesFromFile ? _readEntriesFromFile(file) : []; }
function extractText(content) { return _extractText ? _extractText(content) : ""; }

/** 归一化：去所有空白 + 去尾部标点 + 截断，用于字节级对比 */
export function normReply(s) {
  return String(s || "").replace(/\s+/g, "").replace(/[。．.!！?？]+$/, "").slice(0, 2000);
}

/** 基准获取：内存 Map 优先（快），miss 时读会话文件最后一条 assistant 回复（服务重启后也能防首条复读） */
export function lastReplyOf(sessionKey, sessionFile) {
  const mem = lastReplyMap.get(sessionKey);
  if (mem) return mem;
  if (!sessionFile || !fs.existsSync(sessionFile)) return null;
  try {
    const entries = readEntriesFromFile(sessionFile);
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === "message" && e?.message?.role === "assistant") {
        const t = extractText(e.message.content) || "";
        const n = normReply(t);
        if (n.length >= 30) return n;
      }
    }
  } catch {}
  return null;
}

// 本轮**开跑之前**的基准（2026-09-16 修首轮误判）。
// 真机现象：全新会话的第一轮就报「与上一条完整回复完全相同」，然后静默换模型重写。
// 原因：pi 通道在本轮中就把回复写进了会话文件，而守卫 miss 内存后**读文件**当基准——
// 读到的是它自己刚写的那条 → 必然"复读"。
// 所以基准必须在**动笔之前**取好；取不到就是 null（首轮无基准 = 不可能复读）。
export function lastAssistantReply({ sessionFile = null, tree = null } = {}) {
  try {
    const roots = Array.isArray(tree) ? tree : [];
    if (roots.length) {
      const flat = [];
      const walk = (n) => { if (!n) return; if (n.entry) flat.push(n.entry); const kids = n.children instanceof Map ? [...n.children.values()] : n.children; if (Array.isArray(kids)) for (const c of kids) walk(c); };
      for (const r of roots) walk(r);
      for (let i = flat.length - 1; i >= 0; i--) {
        const m = flat[i]?.message;
        if (m?.role !== "assistant") continue;
        const n = normReply(extractText(m.content) || "");
        if (n.length >= 30) return n;
      }
    }
  } catch {}
  return lastReplyOf("", sessionFile);
}

/** 复读判定：与上一条完整回复（归一化后）完全相同；短回复(<30字符)不判防误伤 */
// 2026-08-21 清理模型输出里的 undefined 污染（独创好能力：模型把 JS 占位符拼进回复）
// 只清"孤立"的 undefined（前后是空白/标点），不误删用户内容
export function sanitizeUndefined(text) {
  if (!text || !/undefined/.test(text)) return text;
  return String(text)
    // 行首/标点后的 undefined（含后跟中文的"undefined工作空间"）
    .replace(/(^|[\s　，,。.；;：:！!？?（(）)])(undefined)(?=$|[\s　，,。.；;：:！!？?）)]|[一-鿿])/g, "$1")
    // 中文/标点前的 undefined（"内容undefined结尾"）
    .replace(/([一-鿿\s　，,。.；;：:！!？?（(）)])(undefined)(?=\s|$)/g, "$1")
    // 清理可能留下的双空格
    .replace(/\s{2,}/g, " ")
    .trim();
}

// baseline：本轮开跑前取好的"上一条回复"（见 lastAssistantReply）。传入时不看内存/文件——
// 因为本轮自己的回复可能已经落盘了，再看文件就成了"拿自己跟自己比"。
export function isRepeatReply(sessionKey, text, sessionFile, baseline = undefined) {
  if (!text || normReply(text).length < 30) return false;
  // 2026-08-21 修复误判：身份类固定格式回答（"我叫小语/当前使用模型是"）天然重复（连续问"你是谁"回答一致）
  // 不算复读——身份格式回答重复是预期行为，守卫只针对"内容循环"（复读机）
  if (/我叫小语|当前使用模型是|当前使用模型：/.test(normReply(text))) return false;
  const last = baseline !== undefined ? baseline : lastReplyOf(sessionKey, sessionFile);
  return !!last && last === normReply(text);
}

// 纯标记文本（模型复读占位标记，如"（交付文件）"）→ 视为异常，正文为空
const MARKER_ONLY_RE = /^[\(（\s]*(?:交付文件|文件交付|已交付|交付中?)[\)）\s]*$/;

/**
 * 统一异常分类：对一次完整模型输出做四类检查（+marker 纯标记）。
 * @param {{sessionKey:string, text:string, think:string, sessionFile:string}} p
 * @returns {{type:'repeat'|'think-only'|'empty'|'marker'|'none', reason:string}}
 */
export function classifyAnomaly({ sessionKey, text, think = "", sessionFile, baseline = undefined }) {
  const n = normReply(text);
  if (!n) {
    if (normReply(think).length >= 10) return { type: "think-only", reason: "正文为空，回答全在思考里" };
    return { type: "empty", reason: "模型空回复（无任何正文）" };
  }
  if (MARKER_ONLY_RE.test(n)) return { type: "marker", reason: "回复仅为占位标记（交付文件类），正文为空" };
  // 失忆特征（2026-08-25）：stealth 池化模型偶发不带上下文应答——自称无记忆/新对话/报身份
  const AMNESIA_RE = /(这是(我们)?对话的开始|没有看到之前|无法看到之前的对话|消息似乎不太完整|我是(一个)?纯文本(对话)?助手|我无法调用其他模型|(由|by)\s*(Z\.ai|OpenAI|Anthropic|Google DeepMind)\s*训练)/i;
  if (n.length < 600 && AMNESIA_RE.test(n)) return { type: "amnesia", reason: "失忆回复：疑似池化模型未携带上下文" };
  if (/undefined/.test(n)) return { type: "undefined-leak", reason: "输出含 undefined 占位符（模型拼错/异常泄漏）" };
  if (isRepeatReply(sessionKey, text, sessionFile, baseline)) return { type: "repeat", reason: "与上一条完整回复完全相同（repetition loop）" };
  return { type: "none", reason: "" };
}

/** 记录一条正常回复作为下次复读判定的基准（<30 字符不记，避免"好的/知道了"误判） */
export function recordReply(sessionKey, text) {
  const n = normReply(text);
  if (n.length >= 30) lastReplyMap.set(sessionKey, n);
}
