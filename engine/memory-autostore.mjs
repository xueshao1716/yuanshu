// engine/memory-autostore.mjs —— 记忆分层自循环第 1/2 步自动化（2026-10-13 伙伴授权落地）
// 规则（伙伴定稿，见 文档/记忆库架构设计-20261013.md 第九节）：
//   1. 每轮对话结束 → 元枢判断这段内容是否值得沉淀为长期记忆
//   2. 值得沉淀：提炼精简摘要，打标签、打分（importance_score）、设置过期时间
//   3. 双写（向量库 + 多维表格）走 memoryIngest 已有管线
//   5. 清理由 sweepExpired 承担
// 设计约束：
//   · fire-and-forget：绝不阻塞对话响应流；任何错误静默进日志
//   · 只沉淀主人亲自会话（有 executionIdentity 才判）；陌生人/子任务/定时任务不记
//   · 防灌水：会话级冷却 + 全局日上限 + 语义去重（相似 >0.92 视为已记过，跳过）
//   · 判断模型可配置 memory/autostore.json {model:{provider,id}}，默认跟服务端 defaultModel

import fs from "node:fs";
import path from "node:path";
import { settleRecall } from "./recall-journal.mjs";

let _deps = null; // { ingest, recall, getDefaultModel, chat, wsRoot }
export function initMemoryAutoStore(deps) { _deps = deps; }
export function memoryAutoStoreConfigured() { return !!_deps; }

const COOLDOWN_MS = 60 * 1000;
const DAILY_LIMIT = 200;
const MIN_ASSISTANT_LEN = 40;
const DEDUP_SIMILARITY = 0.92;

function stateFile() { return path.join(typeof _deps.wsRoot === "function" ? _deps.wsRoot() : _deps.wsRoot, "memory", "autostore-state.json"); }
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return { sessions: {}, day: "", dayCount: 0 }; } }
function saveState(s) { try { const p = stateFile(); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(s), "utf8"); } catch { } }

function today() { return new Date().toISOString().slice(0, 10); }

/** 判断模型解析：memory/autostore.json {model:{provider,id}} 显式配置 > deps.getModel（服务端默认）。
 *  为什么不直接跟主对话模型：主模型会被限额（实锤：2026-10-13 zai 5小时限额把判断调用全带死）。 */
function judgeModel() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    if (cfg?.model?.provider && cfg?.model?.id) return cfg.model;
  } catch { }
  return _deps.getModel?.() || null;
}
function configFile() { return path.join(typeof _deps.wsRoot === "function" ? _deps.wsRoot() : _deps.wsRoot, "memory", "autostore.json"); }

const JUDGE_PROMPT = `你是记忆沉淀审核员。下面是一轮对话（用户消息 + 助手回复）。判断是否有值得跨会话记住的内容：
- preference：用户明确的偏好/习惯/红线（如"以后都用X""不要Y"）
- task_record：完成的任务及其结果摘要（有交付物/结论的）
- fact：重要的新事实（环境变化/约定/关键信息）
不值得沉淀的：纯闲聊、一次性操作细节、已常见识、问候寒暄、纯代码片段执行。
只输出严格 JSON，不要多余文字：
{"store": true/false, "memory_type": "preference|task_record|fact", "summary": "≤80字的短摘要，写结论不写过程", "importance_score": 0.0到1.0}
importance 打分参考：用户明确偏好与红线 0.8+；重要事实与承诺 0.6-0.8；一般任务结果 0.4-0.6。`;

function parseJudge(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!j || j.store !== true) return null;
    if (!["preference", "task_record", "fact"].includes(j.memory_type)) return null;
    const summary = String(j.summary || "").trim();
    if (!summary) return null;
    const imp = Math.max(0, Math.min(1, Number(j.importance_score) || 0.5));
    return { memory_type: j.memory_type, summary: summary.slice(0, 2000), importance_score: imp };
  } catch { return null; }
}

function wsRootOf() {
  try { return typeof _deps?.wsRoot === "function" ? String(_deps.wsRoot() || "") : String(_deps?.wsRoot || ""); } catch { return ""; }
}

/** 轮次结束后调用。不 await——后台执行，调用方 fire-and-forget。 */
export function settleTurnMemory({ sessionId = "new", user = "", assistant = "", executionIdentity = null, model = null, user_id = "owner" } = {}) {
  if (!_deps) return;
  // 2026-10-24：先给召回台账结算（哪几条记忆真被用上了），再走"要不要沉淀"的判断。
  // 两件事无关：沉淀是写新记忆，结算是给已有记忆记功/记过；结算还被执行身份门槛
  // 之外的每一轮覆盖（含测试轮），因为它只改自己的小台账。
  try {
    const ws = wsRootOf();
    if (ws) settleRecall(ws, { userMsg: user, assistantText: assistant });
  } catch {}
  const run = async () => {
    // 门槛 1：只有主人亲自会话
    if (!executionIdentity) return;
    // 门槛 2：内容太薄不判
    if (String(assistant || "").trim().length < MIN_ASSISTANT_LEN) return;
    const st = loadState();
    if (st.day !== today()) { st.day = today(); st.dayCount = 0; }
    // 门槛 3：频控
    const last = st.sessions[sessionId]?.lastAt || 0;
    if (Date.now() - last < COOLDOWN_MS) return;
    if (st.dayCount >= DAILY_LIMIT) return;
    // 判断（免费通道，后台跑）
    const judgeModelResolved = judgeModel();
    if (!judgeModelResolved) { console.log("[memory-autostore] 无可用判断模型，本轮跳过"); return; }
    const messages = [
      { role: "system", content: JUDGE_PROMPT },
      { role: "user", content: `【用户】${String(user || "").slice(0, 2000)}\n\n【助手】${String(assistant || "").slice(0, 4000)}` },
    ];
    const r = await _deps.chat(judgeModelResolved, messages);
    const judged = parseJudge(r?.text ?? r?.content ?? r);
    if (!judged) { st.sessions[sessionId] = { ...(st.sessions[sessionId] || {}), lastAt: Date.now(), lastVerdict: "skip" }; saveState(st); return; }
    // 去重：语义相似度高的视为已记过
    try {
      const hits = await _deps.recall(judged.summary, { user_id, topK: 3 });
      const dup = (hits || []).find(h => h.similarity >= DEDUP_SIMILARITY);
      if (dup) { st.sessions[sessionId] = { ...(st.sessions[sessionId] || {}), lastAt: Date.now(), lastVerdict: "dup" }; saveState(st); return; }
    } catch { } // 召回去重失败不拦截写入
    // 双写（memoryIngest：建行→向量化→绑定）
    const out = await _deps.ingest({ user_id, memory_type: judged.memory_type, summary: judged.summary, importance_score: judged.importance_score, source: "auto" });
    st.sessions[sessionId] = { ...(st.sessions[sessionId] || {}), lastAt: Date.now(), lastVerdict: "stored", lastMemoryId: out?.item?.memory_id };
    st.dayCount = (st.dayCount || 0) + 1;
    saveState(st);
    console.log(`[memory-autostore] 沉淀: ${judged.memory_type} "${judged.summary.slice(0, 50)}" imp=${judged.importance_score} embedded=${!!out?.vector_id}`);
  };
  run().catch(e => console.log(`[memory-autostore] 静默失败: ${String(e?.message || e).slice(0, 120)}`));
}

/** 管理面：看自循环运行状况（灵魂页/诊断用，只读） */
export function autoStoreStats() {
  if (!_deps) return { enabled: false };
  const st = loadState();
  const sessions = Object.entries(st.sessions || {});
  const stored = sessions.filter(([, v]) => v.lastVerdict === "stored").length;
  return { enabled: true, day: st.day, dayCount: st.dayCount, dailyLimit: DAILY_LIMIT, cooldownMs: COOLDOWN_MS, sessionsTracked: sessions.length, sessionsStored: stored, judgeModel: judgeModel() };
}
