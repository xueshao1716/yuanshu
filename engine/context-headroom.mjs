// ══ 上下文余量 / 单次输出上限（2026-09-18）═══════════════════════════════
//
// 真机事故（用户问"单次输出的模型上限是多少，怎么一直被打断"）：
//   会话上下文涨到 195,264 token（zhipu glm-5.3-flash 的 contextWindow = 200,000），
//   兼容适配器按 `max_tokens = min(模型声明, 窗口 − 输入 − 安全余量)` 算出来只剩 ~400，
//   模型在 **387 token** 处停下（stopReason="length"）；接着 SDK 判定
//   `isRecoverableLength`（输出 387 < 声明 32768）→ 把半截答案删掉、压缩、重试，
//   重试那一轮只吐出 **1 个 token**（空回复）。用户看到的就是"说到一半被打断、还接不上"。
//
// 所以"单次输出上限"不是一个固定数：
//   上限 = min(模型声明的 maxTokens, 上下文窗口 − 已占用 − 安全余量)
// 会话越长，第二项越小；逼近窗口时它会掉到几百 token —— 这才是"被打断"的真机制。
//
// 这个模块只做纯计算（可单测、不依赖 server/SDK）：算余量、判要不要先压缩、生成人话说明。
export const CONTEXT_SAFETY_TOKENS = 4096;
// 低于这个输出预算基本注定被截断（一次 write 一个大文件就要 8k+）
export const MIN_OUTPUT_TOKENS = 8192;
// SDK 压缩后至少要留这么多给输出，否则"压完还是不够"
export const HEADROOM_TARGET_TOKENS = 32768;

/** 还能吐多少 token：不知道窗口就返回 Infinity（不瞎砍） */
export function outputRoomTokens({ contextWindow = 0, usedTokens = 0, safety = CONTEXT_SAFETY_TOKENS } = {}) {
  const win = Number(contextWindow) || 0;
  if (win <= 0) return Infinity;
  const used = Math.max(0, Math.floor(Number(usedTokens) || 0));
  return Math.max(0, Math.floor(win - used - safety));
}

/**
 * 余量体检。
 * @returns {{room:number, declared:number, effectiveMax:number, ratio:number, tight:boolean,
 *            shouldCompact:boolean, contextWindow:number, usedTokens:number}}
 */
export function headroomCheck({ contextWindow = 0, usedTokens = 0, declaredMaxTokens = 0, minOutput = MIN_OUTPUT_TOKENS, safety = CONTEXT_SAFETY_TOKENS } = {}) {
  const win = Math.max(0, Math.floor(Number(contextWindow) || 0));
  const used = Math.max(0, Math.floor(Number(usedTokens) || 0));
  const declared = Math.max(0, Math.floor(Number(declaredMaxTokens) || 0));
  const room = outputRoomTokens({ contextWindow: win, usedTokens: used, safety });
  const finite = Number.isFinite(room);
  // 真正能要到的输出上限：声明的与剩余窗口取小；声明缺失就用剩余窗口
  const effectiveMax = finite ? Math.max(0, Math.min(declared || room, room)) : declared;
  const ratio = win > 0 ? Math.min(1, used / win) : 0;
  const tight = finite && room < minOutput;
  return { room, declared, effectiveMax, ratio, tight, shouldCompact: tight, contextWindow: win, usedTokens: used };
}

/** 占用百分比（人话用） */
export function usedPercent(usedTokens, contextWindow) {
  const win = Number(contextWindow) || 0;
  if (win <= 0) return 0;
  return Math.min(100, Math.round((Math.max(0, Number(usedTokens) || 0) / win) * 100));
}

/** 开跑前/压缩后给用户看的实话（不藏机制，也不吓人） */
export function headroomNote({ contextWindow, usedTokens, room = null, compressed = false, model = "" } = {}) {
  const pct = usedPercent(usedTokens, contextWindow);
  const r = room === null ? outputRoomTokens({ contextWindow, usedTokens }) : room;
  const where = model ? `${model} 的窗口 ${Math.round(contextWindow / 1000)}k` : `上下文窗口 ${Math.round(contextWindow / 1000)}k`;
  if (!Number.isFinite(r)) return "";
  if (compressed) return `🧹 上下文已占 ${pct}%（${where}），压缩后本轮可输出约 ${r} token。`;
  return `⚠️ 上下文已占 ${pct}%（${where}），本轮最多只剩约 ${r} token 可输出——长文件/长回答可能被截断。可以说「压缩上下文」或新开一个会话。`;
}

/** 命中 length 截断时写进会话历史的人话（界面用它显示"被截断"，不再静默半句话） */
export function lengthStopNote({ outputTokens = 0, usedTokens = 0, contextWindow = 0, declaredMaxTokens = 0 } = {}) {
  const out = Math.max(0, Math.floor(Number(outputTokens) || 0));
  const parts = [`本轮输出被上限截断（模型返回 stopReason=length，已输出约 ${out} token）`];
  if (Number(contextWindow) > 0) {
    const pct = usedPercent(usedTokens, contextWindow);
    const room = outputRoomTokens({ contextWindow, usedTokens });
    parts.push(`上下文已占 ${pct}%（${Math.round(Number(usedTokens) || 0)}/${Math.round(Number(contextWindow))} token），留给输出的余量约 ${room} token`);
  }
  if (Number(declaredMaxTokens) > 0) parts.push(`模型声明上限 ${Math.round(Number(declaredMaxTokens))} token`);
  parts.push("说「接着写」我就从断点续，或先「压缩上下文」再继续");
  return parts.join("；") + "。";
}

// ── 粗估 token（只给"自己的循环"用；pi 通道有真实 usage，不用估）──
// 与 engine/session-manager.mjs 的 compactSession 保持同一套系数：中文≈1.5/字，其他≈0.35/字符
export function estimateTokensFromText(text) {
  const s = typeof text === "string" ? text : "";
  if (!s) return 0;
  const cn = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(cn * 1.5 + (s.length - cn) * 0.35);
}

/** 估算一段 OpenAI 风格历史的占用（content 可能是字符串或块数组） */
export function estimateHistoryTokens(history = []) {
  if (!Array.isArray(history)) return 0;
  let n = 0;
  for (const m of history) {
    if (!m) continue;
    const c = m.content;
    if (typeof c === "string") n += estimateTokensFromText(c);
    else if (Array.isArray(c)) for (const b of c) n += estimateTokensFromText(typeof b === "string" ? b : (b?.text || b?.thinking || ""));
    if (Array.isArray(m.tool_calls)) for (const t of m.tool_calls) n += estimateTokensFromText(String(t?.function?.arguments || ""));
  }
  return n;
}

/**
 * 给"元枢自制循环"算输出预算：声明上限与剩余窗口取小。
 * 以前只看声明（clamp 到 32k），上下文快满时会向窗口已经装不下的量要输出——
 * 上游要么 400，要么提前截断。
 */
export function budgetWithinWindow({ declaredMaxTokens = 0, contextWindow = 0, usedTokens = 0, fallback = 8192, floor = 512 } = {}) {
  const declared = Number(declaredMaxTokens) > 0 ? Math.floor(Number(declaredMaxTokens)) : 0;
  const base = declared || fallback;
  const room = outputRoomTokens({ contextWindow, usedTokens });
  if (!Number.isFinite(room)) return base;
  return Math.max(floor, Math.min(base, room));
}

// ── 单次写入的分段闸门（2026-09-18）────────────────────────────────────
// 为什么要有它：一次 write 的内容是**模型的输出**（工具调用参数）。写太大的文件 = 让模型在
// 一次输出里吐完整个文件，一旦超过单次输出上限，参数就会在 JSON 中间断掉，整轮白费
// （真机现象："工具调用被截断"）。
// 起步上限按 32k 输出算（见 output-budget.mjs），这里给写入留一部分余量：超过就拦下来，
// 让模型分块写（第一次 write，之后 write + append:true）。
export const WRITE_SEGMENT_TOKEN_LIMIT = 20000;
export const WRITE_SEGMENT_SUGGEST_TOKENS = 15000;

/** 估算一次 write 的内容要花多少输出 token，并给出"要不要分段"的判定 + 人话指引 */
export function checkWriteSegments({ content = "", append = false, limit = WRITE_SEGMENT_TOKEN_LIMIT, suggest = WRITE_SEGMENT_SUGGEST_TOKENS } = {}) {
  const text = typeof content === "string" ? content : String(content ?? "");
  const tokens = estimateTokensFromText(text);
  const chars = text.length;
  if (tokens <= limit) return { ok: true, tokens, chars, limit, hint: "" };
  const blocks = Math.max(2, Math.ceil(tokens / suggest));
  const how = append
    ? `这一块本身还是太大（约 ${tokens} token）`
    : `请拆成约 ${blocks} 块，每块 ≤ ${suggest} token（≈${Math.floor(suggest / 1.5)} 汉字）`;
  return {
    ok: false,
    tokens,
    chars,
    limit,
    blocks,
    hint: `内容约 ${tokens} token（${chars} 字符），超过单次安全写入上限 ${limit}——一次写完会被单次输出上限截断，参数断在 JSON 中间、整轮白费。`
      + `\n${how}：第一块用 write（不带 append），后面的块用 write + append:true 逐段追加；也可以 bash 用 heredoc/追加重定向。`,
  };
}
