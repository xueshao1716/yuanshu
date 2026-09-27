// 元枢自己的 VAD 情绪接线：开轮注入、收轮推 SSE。不走 pi SDK 的 nextTurn。
import { updateEmotion, updateFromOutput, emotionPrompt, recordFeeling, getSnapshot, flushPersonaAttribution } from "./emotion.mjs";

const recent = new Map();

function sessionKey(id) {
  return String(id || "new");
}

/**
 * 上次对话时间（毫秒），供时间上下文算"距上次对话多久"。
 *
 * ⚠️ 必须在本轮 updateEmotion / beginYuanshuEmotion **之前**调用：
 * 它们会把 lastTalk 刷成当前时间，之后取到的差值恒为 0。
 */
export function lastTalkAt(sessionId) {
  try {
    const at = Number(getSnapshot(sessionKey(sessionId))?.lastTalk);
    return Number.isFinite(at) && at > 0 ? at : 0;
  } catch { return 0; }
}

export function beginYuanshuEmotion(sessionId, message, history = []) {
  const key = sessionKey(sessionId);
  const msg = String(message || "");
  const prev = recent.get(key);
  const now = Date.now();
  if (!prev || prev.msg !== msg || now - prev.at > 10000) {
    updateEmotion(key, msg);
    recent.set(key, { msg, at: now });
  }
  const prompt = emotionPrompt(key, msg);
  if (!prompt) return history;
  if (history.some((m) => m?.role === "system" && /情绪语境/.test(String(m.content || "")))) return history;
  return [{ role: "system", content: prompt }, ...history];
}

export function endYuanshuEmotion(sessionId, message, text, writer) {
  const key = sessionKey(sessionId);
  updateFromOutput(key, text);
  recordFeeling(key, message);
  try { flushPersonaAttribution(key); } catch {}
  const state = getSnapshot(key);
  if (state && writer && typeof writer.push === "function") {
    writer.push("emotion", { state });
  }
  return state;
}
