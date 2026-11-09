// 元枢自己的 VAD 情绪接线：开轮注入、收轮推 SSE。不走 pi SDK 的 nextTurn。
import { updateEmotion, updateFromOutput, emotionPrompt, recordFeeling, getSnapshot, flushPersonaAttribution } from "./emotion.mjs";
// 关系层（2026-11-09）：情绪是分钟级快变量，关系是月级慢变量，摘要紧贴情绪段注入。
import { summary as relationshipSummary } from "./relationship.mjs";
// 2026-11-09 GRN：人格的可观测状态。只注入**一行**漂移摘要，不把 10 个基因全塞进 prompt。
import { promptLine as genomePromptLine } from "./genome.mjs";
import { completeGeneTurn } from './gene-turn.mjs';

const recent = new Map();

function sessionKey(id) {
  return String(id || "new");
}

// 关系一行：读不回来就当场返回空串，绝不因为关系文件影响开轮
function relationshipLine() {
  try {
    const line = relationshipSummary();
    return typeof line === "string" ? line.trim() : "";
  } catch { return ""; }
}

// 人格漂移一行：正常报最接近阈值的簇；超阈值才告警。读不到就不注入，绝不影响开轮。
// 措辞用「人格漂移」而不是「基因」：这一层只读、只说明"偏离基线多少"，
// 和 gene.mjs 那套可改的「性格倾向」（11 基因 aibody 层）不是同一种自我描述。
function genomeLine() {
  try {
    const line = genomePromptLine();
    return typeof line === "string" ? line.replace(/\s*\n\s*/g, " ").trim() : "";
  } catch { return ""; }
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

export function beginYuanshuEmotion(sessionId, message, history = [], context = {}) {
  const key = sessionKey(sessionId);
  const msg = String(message || "");
  const prev = recent.get(key);
  const now = Date.now();
  if (context.turnId || !prev || prev.msg !== msg || now - prev.at > 10000) {
    updateEmotion(key, msg, context);
    recent.set(key, { msg, at: now });
    if (recent.size > 2000) recent.delete(recent.keys().next().value);
  }
  const prompt = emotionPrompt(key, msg);
  // 关系摘要 + 基因漂移放在情绪段同一块 system 里（不是另起一段）：慢变量贴着快变量读，语气才连贯。
  const content = [prompt, relationshipLine(), genomeLine()].filter(Boolean).join("\n");
  if (!content) return history;
  // 去重：历史里已经有同一块就不再插。旧前缀「基因：」一并认——
  // 升级前已注入过的会话历史里还留着那一行，只认新前缀会再插一段，两套措辞就并排出现了。
  if (history.some((m) => m?.role === "system" && /情绪语境|关系：信任|人格漂移：|人格漂移告警：|基因：|基因告警：/.test(String(m.content || "")))) return history;
  return [{ role: "system", content }, ...history];
}

export function endYuanshuEmotion(sessionId, message, text, writer) {
  const key = sessionKey(sessionId);
  updateFromOutput(key, text);
  recordFeeling(key, message);
  try { flushPersonaAttribution(key); } catch {}
  completeGeneTurn(key);
  const state = getSnapshot(key);
  if (state && writer && typeof writer.push === "function") {
    writer.push("emotion", { state });
  }
  return state;
}
