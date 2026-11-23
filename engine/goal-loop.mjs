// ===== goal-loop.mjs —— 长期目标：小语每天围绕你的目标主动跑一轮（2026-11-23）=====
//
// 用户反馈「空间黏性不够」：打开元枢只是聊一句就走，没有一个让人每天回来看的东西。
// 参考 Google Stitch Loop（定目标 → 代理调研出洞察 → 给几档方案 → 你挑一个 → 代理去做 → 记进展）。
// 最小版：
//   - 最多 3 个进行中的目标，存 WS_ROOT/记忆/长期目标.json
//   - 每个目标每天自动跑一轮：模型看目标 + 已有进展 + 今日晨报事实，出 1–3 张洞察卡，每张 2–3 个方案
//   - 首页显示待处理的洞察卡；点方案 = 在对话里让小语去做，同时记一条进展
// 和 engine/goals.mjs（对话内跨轮推进的闸门）、idea-curator 的「已采纳目标」不是一回事，互不读写。
// 纯函数 + 注入依赖，server.mjs 只负责接路由和定时器。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MAX_ACTIVE = 3;
const MAX_PENDING = 6;     // 每个目标最多积压的待处理洞察，超出的旧卡标成过期
const MAX_LOG = 50;
const MAX_INSIGHTS = 40;   // 含已处理的历史

export function goalLoopFile(wsRoot) { return path.join(wsRoot, "记忆", "长期目标.json"); }

const newId = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
export const localDate = (d) => { try { return d.toLocaleDateString("sv-SE") } catch { return d.toISOString().slice(0, 10) } };

export function readLoopGoals(wsRoot) {
  try {
    const d = JSON.parse(fs.readFileSync(goalLoopFile(wsRoot), "utf8"));
    return Array.isArray(d?.goals) ? d.goals : [];
  } catch { return []; }
}

export function writeLoopGoals(wsRoot, goals) {
  const file = goalLoopFile(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ goals }, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function createLoopGoal(goals, { title, detail } = {}, now = new Date()) {
  const t = clip(title, 80);
  if (!t) throw bad("目标不能为空");
  if (goals.filter(g => g.status === "active").length >= MAX_ACTIVE) throw bad(`最多同时进行 ${MAX_ACTIVE} 个目标，先完成或暂停一个`);
  const g = { id: newId("g"), title: t, detail: clip(detail, 500), status: "active", createdAt: now.toISOString(), lastRunAt: "", insights: [], log: [] };
  return [...goals, g];
}

export function updateLoopGoal(goals, gid, patch = {}) {
  const g = goals.find(x => x.id === gid);
  if (!g) throw bad("目标不存在", 404);
  const next = { ...g };
  if (patch.title != null) { next.title = clip(patch.title, 80); if (!next.title) throw bad("目标不能为空"); }
  if (patch.detail != null) next.detail = clip(patch.detail, 500);
  if (patch.status != null) {
    if (!["active", "paused", "done"].includes(patch.status)) throw bad("状态不对");
    if (patch.status === "active" && g.status !== "active" && goals.filter(x => x.status === "active").length >= MAX_ACTIVE)
      throw bad(`最多同时进行 ${MAX_ACTIVE} 个目标`);
    next.status = patch.status;
  }
  return goals.map(x => x.id === gid ? next : x);
}

/** 从模型输出里抠出洞察数组；容忍 ```json 包裹和前后废话 */
export function parseInsights(text) {
  const s = String(text || "");
  const start = s.indexOf("["), end = s.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr.slice(0, 3)) {
    const problem = clip(it?.problem || it?.insight, 160);
    const options = (Array.isArray(it?.options) ? it.options : [])
      .map(o => typeof o === "string" ? { label: clip(o, 40), detail: "" } : { label: clip(o?.label, 40), detail: clip(o?.detail, 200) })
      .filter(o => o.label).slice(0, 3);
    if (!problem || options.length < 2) continue;
    const conf = String(it?.confidence || "").toLowerCase();
    out.push({
      problem,
      evidence: clip(it?.evidence, 240),
      confidence: ["high", "medium", "low"].includes(conf) ? conf : "medium",
      options: options.map((o, i) => ({ id: `o${i + 1}`, ...o })),
    });
  }
  return out;
}

export function buildInsightPrompt(goal, { facts = "", today = "" } = {}) {
  const done = (goal.log || []).slice(-8).map(l => `- ${String(l.at).slice(0, 10)} ${l.text}`).join("\n") || "（还没有记录）";
  const skipped = (goal.insights || []).filter(i => i.status === "skipped").slice(-5).map(i => `- ${i.problem}`).join("\n");
  return [
    `你是小语，用户的长期助手。今天是 ${today}。用户设了一个长期目标，请围绕它做今天的一轮复盘，找出此刻最值得推进的 1–3 个点。`,
    ``,
    `【目标】${goal.title}`,
    goal.detail ? `【补充说明】${goal.detail}` : "",
    `【已做过的】\n${done}`,
    skipped ? `【用户跳过的（别再提类似的）】\n${skipped}` : "",
    facts ? `【最近的工作事实（只作背景）】\n${facts}` : "",
    ``,
    `要求：`,
    `- 每个点都必须直接服务于上面这个目标；工作事实里和目标无关的故障、任务、指标一律不要写成洞察`,
    `- 宁缺毋滥：只有 1 个值得做就只给 1 个`,
    `- 每个点写清楚：现在的问题/机会是什么（problem），依据是什么（evidence），你有多确定（confidence: high/medium/low）`,
    `- 每个点给 2–3 个可选方案（options），从省力到彻底排开；label 是一句动词开头的短句（≤20 字），detail 说明具体会做什么`,
    `- 方案必须是你（能用电脑、读写文件、搜索、写代码的助手）接下来能动手做的，不要空话`,
    `- 不要重复已做过的事`,
    ``,
    `只输出 JSON 数组，不要其他文字：`,
    `[{"problem":"...","evidence":"...","confidence":"medium","options":[{"label":"...","detail":"..."},{"label":"...","detail":"..."}]}]`,
  ].filter(Boolean).join("\n");
}

/** 给目标挂上新洞察（待处理的超过上限，最旧的标成过期） */
export function addInsights(goal, insights, now = new Date()) {
  const fresh = insights.map(it => ({ id: newId("i"), at: now.toISOString(), ...it, status: "pending", choice: "" }));
  let list = [...(goal.insights || []), ...fresh];
  const pending = list.filter(i => i.status === "pending");
  if (pending.length > MAX_PENDING) {
    const drop = new Set(pending.slice(0, pending.length - MAX_PENDING).map(i => i.id));
    list = list.map(i => drop.has(i.id) ? { ...i, status: "expired" } : i);
  }
  return { ...goal, insights: list.slice(-MAX_INSIGHTS), lastRunAt: now.toISOString() };
}

export function resolveInsight(goals, gid, iid, { action, optionId } = {}, now = new Date()) {
  const g = goals.find(x => x.id === gid);
  if (!g) throw bad("目标不存在", 404);
  const ins = (g.insights || []).find(i => i.id === iid);
  if (!ins) throw bad("这条洞察不存在", 404);
  if (ins.status !== "pending") throw bad("这条已经处理过了", 409);
  let next, logText = "", option = null;
  if (action === "skip") {
    next = { ...ins, status: "skipped" };
  } else if (action === "choose") {
    option = ins.options.find(o => o.id === optionId);
    if (!option) throw bad("方案不存在");
    next = { ...ins, status: "chosen", choice: option.id };
    logText = `${option.label}（针对：${ins.problem}）`;
  } else throw bad("未知操作");
  const log = logText ? [...(g.log || []), { at: now.toISOString(), text: clip(logText, 240) }].slice(-MAX_LOG) : (g.log || []);
  const goal = { ...g, insights: g.insights.map(i => i.id === iid ? next : i), log };
  return { goals: goals.map(x => x.id === gid ? goal : x), goal, insight: next, option };
}

/** 点了方案后发进对话的那句话 */
export function executionPrompt(goal, insight, option) {
  return [
    `围绕我的长期目标「${goal.title}」，执行这个方案：${option.label}`,
    option.detail ? `具体：${option.detail}` : "",
    `背景：${insight.problem}`,
    `做完告诉我结果和下一步建议。`,
  ].filter(Boolean).join("\n");
}

/** 今天还没跑过的进行中目标 */
export function dueGoals(goals, now = new Date()) {
  const today = localDate(now);
  return goals.filter(g => g.status === "active" && (!g.lastRunAt || localDate(new Date(g.lastRunAt)) !== today));
}

/** 给前端的形状：只带待处理洞察 + 最近几条进展，历史不往外倒 */
export function publicGoal(g) {
  return {
    id: g.id, title: g.title, detail: g.detail, status: g.status, createdAt: g.createdAt, lastRunAt: g.lastRunAt,
    pending: (g.insights || []).filter(i => i.status === "pending"),
    log: (g.log || []).slice(-5),
  };
}

/**
 * 跑一轮：chat(prompt) → 文本；facts() → 最近工作事实摘要。
 * 失败不改 lastRunAt，下次还会再试。
 */
export async function runLoopGoal(wsRoot, gid, { chat, facts = async () => "", now = new Date() } = {}) {
  const g = readLoopGoals(wsRoot).find(x => x.id === gid);
  if (!g) throw bad("目标不存在", 404);
  let factText = "";
  try { factText = clip(await facts(), 1500); } catch {}
  const text = await chat(buildInsightPrompt(g, { facts: factText, today: localDate(now) }));
  const insights = parseInsights(text);
  if (!insights.length) return { ok: false, error: "这轮没想出可用的方案，稍后再试" };
  // 跑模型期间用户可能改过目标：重新读一次再写
  const latest = readLoopGoals(wsRoot);
  const cur = latest.find(x => x.id === gid);
  if (!cur) return { ok: false, error: "目标已删除" };
  const goal = addInsights(cur, insights, now);
  writeLoopGoals(wsRoot, latest.map(x => x.id === gid ? goal : x));
  return { ok: true, goal, added: insights.length };
}
