// ===== drift-escalation.mjs —— 从「记账」到「介入」（2026-11-07）=====
//
// watchdog-drift 已经能判「空转/连续失败/只改不验」，但判完只落台账，没人被打扰。
// 这里补的是**要不要因此打扰人**：同类问题给一个冷却窗，不重复喊；不同类的新问题可以立刻喊。
// 绝不自动杀任务——原文与元枢自己的经验都是：误伤长任务的代价高于多等一轮。
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 同一件事 4 小时内只喊一次
export const STORM_WINDOW_MS = 30 * 60 * 1000; // 同一签名全域 30 分钟防洪
export const NOTIFY_REL = path.join("记忆", "运行时", "看门狗通知.json");

export function notifyFile(wsRoot) {
  return path.join(String(wsRoot || "."), NOTIFY_REL);
}

/** 一次判定结果的稳定签名：同一批问题 → 同一个键（按 issue.code）。 */
export function signatureOf(issues = []) {
  const codes = [...new Set((Array.isArray(issues) ? issues : []).map((i) => String(i?.code || i?.kind || "drift")))].sort();
  return codes.join("+") || "drift";
}

/**
 * 「这件事」的身份：优先会话，其次 run/task；一个都没有就用 none。
 * 2026-11-19 收紧：重复提醒的根因不是签名不够细，而是签名**没带身份**——
 * 同一个会话的问题组合一变（failing → failing+loop+no_gate）就被当成新问题再喊一遍。
 */
export function incidentKeyOf(issues = []) {
  const list = Array.isArray(issues) ? issues : [];
  for (const i of list) {
    const s = String(i?.sessionId || "").trim();
    if (s) return `s:${s}`;
  }
  for (const i of list) {
    const r = String(i?.runId || "").trim();
    if (r) return `r:${r}`;
  }
  for (const i of list) {
    const t = String(i?.taskId || "").trim();
    if (t) return `t:${t}`;
  }
  return "none";
}

/** 台账里的一条记录可能是新格式对象，也可能是旧格式数字（老文件兼容）。 */
function normalizeEntry(key, raw) {
  if (raw && typeof raw === "object") {
    return { at: Number(raw.at || 0), incident: String(raw.incident || ""), sig: String(raw.sig || key || "drift") };
  }
  return { at: Number(raw || 0), incident: "", sig: String(key || "drift") };
}

/**
 * 要不要把这次 drift 推给人。
 *
 * 2026-11-19 收紧后的三条规则（按顺序判定，命中即不推）：
 * ① 同一件事（会话/run/task）在冷却窗内已经提醒过 → 不再提醒，**签名变化也不再提醒**；
 * ② 同一签名（问题组合）全 30 分钟内已经提醒过 → 不再提醒（一次系统性故障别同时轰十几个会话）；
 * ③ 其余情况 → 提醒。
 *
 * @returns {{ escalate:boolean, key:string, incident:string, reason:string }}
 */
export function shouldEscalate({
  drift = false, issues = [], now = Date.now(), last = {},
  cooldownMs = DEFAULT_COOLDOWN_MS, stormWindowMs = STORM_WINDOW_MS,
} = {}) {
  const key = signatureOf(issues);
  const incident = incidentKeyOf(issues);
  if (!drift || !issues.length) return { escalate: false, key, incident, reason: "没有偏离" };
  const entries = Object.entries(last || {}).map(([k, v]) => [k, normalizeEntry(k, v)]);

  // ① 同一件事：签名变了也算同一件事，冷却窗内只喊一次。
  for (const [, e] of entries) {
    if (e.incident && e.incident === incident && now - e.at < cooldownMs) {
      const same = e.sig === key ? "同类问题" : `同一件事换了签名（上次 ${e.sig}）`;
      return { escalate: false, key, incident, reason: `${same} ${Math.round((now - e.at) / 60000)} 分钟前刚报过` };
    }
  }

  // ② 同一签名全域防洪：不同会话但是同一种问题，30 分钟内只喊一次。
  for (const [, e] of entries) {
    if (e.sig === key && now - e.at < stormWindowMs) {
      return { escalate: false, key, incident, reason: `同一签名 ${Math.round((now - e.at) / 60000)} 分钟前刚报过（防洪窗口）` };
    }
  }

  return { escalate: true, key, incident, reason: "新出现或已过冷却窗口" };
}

/** 本地时区的 HH:mm（只给人看）。 */
function fmtClock(ms) {
  const d = new Date(Number(ms));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** run/session 的 uuid 在 IM 里只显示前 8 位（完整 id 在事件接口里）。 */
function shortId(id) {
  const s = String(id || "").trim();
  return s.length > 12 ? s.slice(0, 8) : s;
}

/** 「哪一轮」：优先 run，其次会话/任务；一个 id 都没有就明说只能看时间。 */
function taskLabel(issue, { unnamed = false } = {}) {
  const start = Number(issue?.startedAt || issue?.firstAt || 0);
  const startText = start ? `${fmtClock(start)} 开始` : "时间未知";
  const more = Array.isArray(issue?.runIds) && issue.runIds.length > 1 ? `，另有 ${issue.runIds.length - 1} 轮` : "";
  // 这一轮没有人类可读的任务名时，明说「这轮没带名字」——伙伴才知道为什么只能看到 id。
  const suffix = unnamed ? "，这轮没带名字" : "";
  if (issue?.runId) return `run ${shortId(issue.runId)}（${startText}${more}${suffix}）`;
  if (issue?.sessionId) return `会话 ${shortId(issue.sessionId)}（${startText}${more}${suffix}）`;
  if (issue?.taskId) return `任务 ${issue.taskId}（${startText}${more}${suffix}）`;
  const first = Number(issue?.firstAt || 0);
  const last = Number(issue?.lastAt || 0);
  const range = first
    ? (last && last - first > 60_000 ? `${fmtClock(first)}–${fmtClock(last)}` : fmtClock(first))
    : "";
  return `这轮没带 id，只能看时间（${range || "时间未知"}）${unnamed ? "（这轮没带名字）" : ""}`;
}

/**
 * 有任务名时先说「哪件事」：`整理桌面截图（run f2170fcd，22:31）`。
 * 时间只到分钟（IM 里够用），"另有 N 轮"照旧保留。
 */
function titledLabel(issue, title) {
  const start = Number(issue?.startedAt || issue?.firstAt || 0);
  const when = start ? `，${fmtClock(start)}` : "";
  const more = Array.isArray(issue?.runIds) && issue.runIds.length > 1 ? `，另有 ${issue.runIds.length - 1} 轮` : "";
  if (issue?.runId) return `${title}（run ${shortId(issue.runId)}${when}${more}）`;
  if (issue?.sessionId) return `${title}（会话 ${shortId(issue.sessionId)}${when}${more}）`;
  if (issue?.taskId) return `${title}（任务 ${issue.taskId}${when}${more}）`;
  return start ? `${title}（${fmtClock(start)}）` : title;
}

/**
 * 推送正文：短、可操作，并回答「哪一轮 / 哪个工具 / 失败成什么样 / 去哪里看」。
 * incidentId 与接口 /api/watchdog/drift/<id> 保持一致。
 */
export function composeDriftNotice(issues = [], { limit = 3, incidentId = "" } = {}) {
  const rows = (Array.isArray(issues) ? issues : []).slice(0, Math.max(1, limit));
  const lines = [];
  for (const i of rows) {
    const detail = String(i?.detail || i?.reason || i?.code || "偏离").slice(0, 80);
    const tool = String(i?.tool || "").trim();
    // detail 里通常已带工具名（bash 连续失败…）；只改不验这类没说工具的，补一个前缀。
    const toolPrefix = tool && !detail.startsWith(tool) ? `${tool} · ` : "";
    // 有任务名就先说「哪件事」，再给 run id 与时间；没有名字时退回旧写法并明说「这轮没带名字」。
    const title = String(i?.title || "").trim();
    const subject = title ? titledLabel(i, title) : taskLabel(i, { unnamed: true });
    lines.push(`· 任务：${subject} · ${toolPrefix}${detail}`);
    const samples = Array.isArray(i?.samples) ? i.samples.filter(Boolean) : [];
    const latest = samples[0] ? String(samples[0]).slice(0, 80) : "";
    lines.push(`  最近一次：${latest || "没留到失败输出，只能看到次数"}`);
  }
  const link = incidentId
    ? `/api/watchdog/drift/${encodeURIComponent(incidentId)}`
    : "/api/watchdog/drift/latest";
  return [
    "看门狗：有一个任务可能跑偏了（没动它）",
    ...lines,
    `· 详情：${link}`,
    "回「继续」我不管；回「停」我收尾。",
  ].join("\n");
}

/** 读上次通知台账。新格式 `{ "<身份>|<签名>": {at,incident,sig} }`，旧格式 `{ 签名: 时间戳 }` 同样能读。 */
export function readLastNotified(wsRoot) {
  try { return JSON.parse(fs.readFileSync(notifyFile(wsRoot), "utf8"))?.last || {} } catch { return {} }
}

/** 记一次已通知（只留最近 50 条；按时间倒序裁剪，新旧两种格式都按 at 排序）。 */
export function recordNotified(wsRoot, key, { now = Date.now(), incident = "", sig = "" } = {}) {
  const prev = readLastNotified(wsRoot);
  const raw = String(key || "drift");
  const [keyIncident, keySig] = raw.includes("|") ? raw.split("|") : ["", raw];
  const entry = {
    at: Number(now),
    incident: String(incident || keyIncident || ""),
    sig: String(sig || keySig || "drift"),
  };
  const storeKey = entry.incident ? `${entry.incident}|${entry.sig}` : entry.sig;
  const last = { ...prev, [storeKey]: entry };
  const keys = Object.keys(last)
    .sort((a, b) => normalizeEntry(b, last[b]).at - normalizeEntry(a, last[a]).at)
    .slice(0, 50);
  const kept = Object.fromEntries(keys.map((k) => [k, last[k]]));
  try {
    fs.mkdirSync(path.dirname(notifyFile(wsRoot)), { recursive: true });
    fs.writeFileSync(notifyFile(wsRoot), JSON.stringify({ last: kept, updatedAt: new Date(now).toISOString() }, null, 2), "utf8");
    return { ok: true, last: kept, key: storeKey };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}
