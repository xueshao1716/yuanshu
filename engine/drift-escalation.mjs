// ===== drift-escalation.mjs —— 从「记账」到「介入」（2026-11-07）=====
//
// watchdog-drift 已经能判「空转/连续失败/只改不验」，但判完只落台账，没人被打扰。
// 这里补的是**要不要因此打扰人**：同类问题给一个冷却窗，不重复喊；不同类的新问题可以立刻喊。
// 绝不自动杀任务——原文与元枢自己的经验都是：误伤长任务的代价高于多等一轮。
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 同类问题 4 小时内只喊一次
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
 * 要不要把这次 drift 推给人。
 * @returns {{ escalate:boolean, key:string, reason:string }}
 */
export function shouldEscalate({ drift = false, issues = [], now = Date.now(), last = {}, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const key = signatureOf(issues);
  if (!drift || !issues.length) return { escalate: false, key, reason: "没有偏离" };
  const prev = Number(last?.[key] || 0);
  if (prev && now - prev < cooldownMs) {
    return { escalate: false, key, reason: `同类问题 ${Math.round((now - prev) / 60000)} 分钟前刚报过` };
  }
  return { escalate: true, key, reason: "新出现或已过冷却窗口" };
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
function taskLabel(issue) {
  const start = Number(issue?.startedAt || issue?.firstAt || 0);
  const startText = start ? `${fmtClock(start)} 开始` : "时间未知";
  const more = Array.isArray(issue?.runIds) && issue.runIds.length > 1 ? `，另有 ${issue.runIds.length - 1} 轮` : "";
  if (issue?.runId) return `run ${shortId(issue.runId)}（${startText}${more}）`;
  if (issue?.sessionId) return `会话 ${shortId(issue.sessionId)}（${startText}${more}）`;
  if (issue?.taskId) return `任务 ${issue.taskId}（${startText}${more}）`;
  const first = Number(issue?.firstAt || 0);
  const last = Number(issue?.lastAt || 0);
  const range = first
    ? (last && last - first > 60_000 ? `${fmtClock(first)}–${fmtClock(last)}` : fmtClock(first))
    : "";
  return `这轮没带 id，只能看时间（${range || "时间未知"}）`;
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
    lines.push(`· 任务：${taskLabel(i)} · ${toolPrefix}${detail}`);
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

/** 读上次通知时间表（{签名: 时间戳}）。 */
export function readLastNotified(wsRoot) {
  try { return JSON.parse(fs.readFileSync(notifyFile(wsRoot), "utf8"))?.last || {} } catch { return {} }
}

/** 记一次已通知（只留最近 50 个签名）。 */
export function recordNotified(wsRoot, key, { now = Date.now() } = {}) {
  const last = { ...readLastNotified(wsRoot), [String(key || "drift")]: now };
  const keys = Object.keys(last).sort((a, b) => last[b] - last[a]).slice(0, 50);
  const kept = Object.fromEntries(keys.map((k) => [k, last[k]]));
  try {
    fs.mkdirSync(path.dirname(notifyFile(wsRoot)), { recursive: true });
    fs.writeFileSync(notifyFile(wsRoot), JSON.stringify({ last: kept, updatedAt: new Date(now).toISOString() }, null, 2), "utf8");
    return { ok: true, last: kept };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}
