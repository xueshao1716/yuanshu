// 元枢自己的 VAD 情绪接线：开轮注入、收轮推 SSE。不走 pi SDK 的 nextTurn。
import { updateEmotion, updateFromOutput, emotionPrompt, recordFeeling, getSnapshot, flushPersonaAttribution } from "./emotion.mjs";
// 关系层（2026-11-09）：情绪是分钟级快变量，关系是月级慢变量，摘要紧贴情绪段注入。
import { summary as relationshipSummary } from "./relationship.mjs";
// 2026-11-09 GRN：人格的可观测状态。只注入**一行**漂移摘要，不把 10 个基因全塞进 prompt。
import { promptLine as genomePromptLine } from "./genome.mjs";
// 2026-11-09：5 维成长也只占一行，紧贴「人格漂移」——同一个 system 块里的并列行，不另起段落。
import { promptLine as growthPromptLine } from "./genome-growth.mjs";
// 2026-11-09：反模式台账。和漂移/成长同一块注入，每条一行，最多 2 条；无匹配返回空串（零注入）。
import { antiPatternPromptLine, alreadyInjected } from "./anti-patterns.mjs";
// 2026-11-09：教训复习。一天最多一次、最多 2 条，和反模式同一块（前缀「复习：」）。
// 这一行有落盘副作用（注入即记账），所以下面必须先判去重、再取它。
import { replayPromptLine } from "./lesson-replay.mjs";
import { completeGeneTurn } from "./gene-turn.mjs";

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

// 成长一行：与人格漂移并列（同一 system 块里的下一行）；读不到就返回空串，绝不影响开轮。
function growthLine() {
  try {
    const line = growthPromptLine();
    return typeof line === "string" ? line.replace(/\s*\n\s*/g, " ").trim() : "";
  } catch { return ""; }
}

// 反模式：只注入与本轮场景最相关的 2 条，每条一行「⚠ 别：… → 该：…」。
// 多行是故意的（一条一行才读得动），所以这里不把换行压平；读不到/没匹配都返回空串。
function antiPatternLine(msg, context = {}) {
  try {
    const line = antiPatternPromptLine({ text: msg, tools: context?.tools || context?.toolNames || [] });
    return typeof line === "string" ? line.trim() : "";
  } catch { return ""; }
}

// 复习：每天第一次进对话时最多注入 2 条到期的教训，注入即记账；没有到期/今天已经念过都返回空串。
function replayLine(history) {
  try {
    const line = replayPromptLine({ history });
    return typeof line === "string" ? line.trim() : "";
  } catch { return ""; }
}

// 同一块的旧前缀都认：升级前注入过的会话历史里还留着老措辞，只认新前缀会再插一段。
const INJECTED_BLOCK = /情绪语境|关系：信任|人格漂移：|人格漂移告警：|成长：|基因：|基因告警：|复习：/;

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
  // 去重：历史里已经有同一块就不再插。旧前缀「基因：」一并认——
  // 升级前注入过的会话历史里还留着那一行，只认新前缀会再插一段，两套措辞就并排出现了。
  // 必须**先判去重再取复习行**：replayLine 有落盘副作用（注入即记账、当天不再注入），
  // 别在一条会被丢掉的返回路径上把账记了。
  const already = alreadyInjected(history)
    || history.some((m) => m?.role === "system" && INJECTED_BLOCK.test(String(m.content || "")));
  // 关系摘要 + 基因漂移 + 成长 + 反模式 + 复习放在情绪段同一块 system 里（不是另起一段）：
  // 慢变量贴着快变量读，语气才连贯；复习是"想起来"的那一半，跟反模式同一块最省上下文。
  const content = [prompt, relationshipLine(), genomeLine(), growthLine(), antiPatternLine(msg, context), already ? "" : replayLine(history)]
    .filter(Boolean)
    .join("\n");
  if (!content || already) return history;
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
