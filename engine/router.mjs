// ===== router.mjs —— 最小路由器：事件 → 判断 → 派活（2026-11-01）=====
//
// 来源：DeepSeek Harness 的 Super-agent 双层架构（Router 只分派、Worker 只干活）。
// 元枢这边已经有收件箱/定时任务/delegate/交付门/审计，缺的是"谁来决定这件事要不要做"。
//
// 两级过滤照抄它的思路：
//   · 快筛（程序层，不花钱）：来源白名单、重复、噪音、长度
//   · 慢判（模型，轻量）：要不要做 / 值不值得打扰 / 派给谁
//
// 判断结果落 记忆/运行时/路由决策.jsonl，派活走「定时引擎 +1 分钟」这条真实执行链路。
import fs from "node:fs";
import path from "node:path";

export const ROUTER_REL = path.join("记忆", "运行时", "路由决策.jsonl");
const NOISE = /^(收到|好的|嗯+|ok|OK|1|测试|test|在吗|hi|哈+|👍|。|\.)$/;
const MAX_TEXT = 4000;

export function routerFile(wsRoot) {
  return path.join(String(wsRoot || "."), ROUTER_REL);
}

/** 快筛：不花钱，先干掉明显不用理会的。 */
export function fastFilter(event = {}, { sources = [], seen = new Set() } = {}) {
  const text = String(event.text || "").trim();
  const source = String(event.source || "").trim();
  if (!text) return { pass: false, reason: "空事件" };
  if (text.length > MAX_TEXT) return { pass: false, reason: "太长" };
  if (NOISE.test(text)) return { pass: false, reason: "噪音" };
  if (source && sources.length && !sources.includes(source)) return { pass: false, reason: `来源不在白名单：${source}` };
  const key = `${source}|${text.replace(/\s+/g, "")}`.slice(0, 200);
  if (seen.has(key)) return { pass: false, reason: "重复" };
  return { pass: true, key };
}

/** 慢判提示词：只让它做选择，不许长篇解释。 */
export function buildRoutePrompt(event, { maxAgeHours = 24 } = {}) {
  return [
    "你是元枢的路由器。判断这条外部事件要不要处理，不要执行。",
    "",
    `来源：${event.source || "未知"}`,
    `类型：${event.kind || "未知"}`,
    `时间：${event.at ? new Date(event.at).toISOString() : "未知"}`,
    `内容：${String(event.text || "").slice(0, 1200)}`,
    "",
    `现在时间：${new Date().toISOString()}（事件超过 ${maxAgeHours} 小时就按"过期"处理）`,
    "",
    "可选动作：",
    '- "ignore"：不用管（广告、通知、闲聊、重复、过期）',
    '- "ask"：要人拍板才能做（涉及花钱、对外发布、删数据、改人格、权限）',
    '- "dispatch"：可以自己派人去做（查证、整理、修复、写文件、跑测试这类）',
    "",
    '只输出一个 JSON，不要解释：{"action":"ignore|ask|dispatch","reason":"一句话","task":"dispatch 时要做什么（可独立执行的一句指令）"}',
  ].join("\n");
}

/** 解析模型输出：容错取最后一个 JSON，并校验动作合法。 */
export function parseDecision(text) {
  const raw = String(text || "");
  const candidates = [...raw.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0]);
  for (const c of candidates.reverse()) {
    let obj = null;
    try { obj = JSON.parse(c) } catch { continue }
    const action = String(obj?.action || "");
    if (!["ignore", "ask", "dispatch"].includes(action)) continue;
    const reason = String(obj?.reason || "").slice(0, 200);
    const task = String(obj?.task || "").slice(0, 1500);
    if (action === "dispatch" && !task) continue;
    return { ok: true, action, reason, task };
  }
  return { ok: false, reason: "模型没给出合法判断" };
}

/** 落一条决策（JSONL，保留最近 500 行）。 */
export function recordDecision(wsRoot, record = {}) {
  const file = routerFile(wsRoot);
  const row = { at: Date.now(), ...record };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
    // 截断
    try {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length > 500) fs.writeFileSync(file, lines.slice(-500).join("\n") + "\n", "utf8");
    } catch {}
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

/** 读最近决策（给事务台）。 */
export function recentDecisions(wsRoot, limit = 20) {
  try {
    return fs.readFileSync(routerFile(wsRoot), "utf8").split(/\r?\n/).filter(Boolean)
      .slice(-Math.max(1, limit)).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse();
  } catch { return [] }
}

/**
 * 跑一次路由：快筛 → 慢判 → 决策。
 * @param {{event:object, wsRoot:string, think:(prompt:string)=>Promise<string>, sources?:string[], seen?:Set<string>}} opts
 */
export async function routeEvent({ event, wsRoot, think, sources = [], seen = new Set() } = {}) {
  const fast = fastFilter(event, { sources, seen });
  if (!fast.pass) {
    const rec = recordDecision(wsRoot, { source: event?.source || "", action: "ignore", by: "fast", reason: fast.reason });
    return { ok: true, action: "ignore", by: "fast", reason: fast.reason, recorded: rec.ok };
  }
  if (typeof think !== "function") return { ok: false, error: "没有判断通道" };
  let text = "";
  try { text = String(await think(buildRoutePrompt(event)) || "") } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
  const parsed = parseDecision(text);
  if (!parsed.ok) {
    recordDecision(wsRoot, { source: event?.source || "", action: "ignore", by: "slow", reason: `判断失败：${parsed.reason}`, raw: text.slice(0, 300) });
    return { ok: false, error: parsed.reason };
  }
  const rec = recordDecision(wsRoot, { source: event?.source || "", kind: event?.kind || "", action: parsed.action, by: "slow", reason: parsed.reason, task: parsed.task, text: String(event?.text || "").slice(0, 300) });
  return { ok: true, action: parsed.action, reason: parsed.reason, task: parsed.task, by: "slow", recorded: rec.ok };
}
