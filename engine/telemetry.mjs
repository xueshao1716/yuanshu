// engine/telemetry.mjs —— 分发主机自动问题上报（2026-10-13）
// 场景：分发出去的元枢自己发现异常（服务 crash / 被重启 / 连续模型失败），
// 整理成结构化报告发回开发者，用户无感（技术事实，绝不含对话内容/个人数据）。
// 约束：①每日最多 3 条自动报告 ②只发规则模板提取的事实 ③开关可关 ④本机是工作台时不发（自己给自己发没意义）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MAX_PER_DAY = 3;
const DEV_FEEDBACK_URL = process.env.YUANSHU_FEEDBACK_URL || "https://pi.myxinyu.xin/api/public/feedback";

function stateFile(agentDir) { return path.join(agentDir, "telemetry-state.json"); }

function loadState(agentDir) {
  try { return JSON.parse(fs.readFileSync(stateFile(agentDir), "utf8")); } catch { return { enabled: true, sent: [] }; }
}
function saveState(agentDir, st) {
  try {
    fs.mkdirSync(path.dirname(stateFile(agentDir)), { recursive: true });
    // 只保留 7 天内的发送记录（限频窗口用）
    const cutoff = Date.now() - 7 * 86400000;
    st.sent = (st.sent || []).filter(s => s.at >= cutoff);
    fs.writeFileSync(stateFile(agentDir), JSON.stringify(st, null, 2), "utf8");
  } catch { /* 状态写不进就不上报，不影响主功能 */ }
}

/** 采集本机异常事实：crash.log 尾部 + watchdog 重启计数 + 模型失败计数（由调用方注入） */
// 2026-10-25 真机：43 条自动上报里有 23 条是 code=0 的正常退出（运维脚本 stop/update-restart 触发），
// 被当成 crash 报上去。正常退出不是崩溃——只有非 0 退出码或未捕获异常才算。
export function exitCodeOf(line) {
  const m = String(line || "").match(/\[exit\][^\n]*?code=(-?\d+)/i);
  return m ? Number(m[1]) : null;
}

export function collectIncidents({ crashTail = "", watchdogRestarts = 0, modelFailStreak = 0, version = "" } = {}) {
  const incidents = [];
  if (crashTail) {
    const exitLine = (crashTail.match(/\[exit\][^\n]*/i) || [""])[0];
    const exceptionLine = (crashTail.match(/uncaughtException:[^\n]*/i) || [""])[0];
    const code = exitCodeOf(exitLine);
    // code=0 → 正常退出，不上报；有未捕获异常照样算；拿不到 code（被强杀）也算异常
    if (exceptionLine) incidents.push({ kind: "crash", summary: exceptionLine.slice(0, 160) });
    else if (exitLine && code !== 0) incidents.push({ kind: "crash", summary: exitLine.slice(0, 160) });
  }
  if (watchdogRestarts > 0) incidents.push({ kind: "restart", summary: `watchdog 重启 ${watchdogRestarts} 次` });
  if (modelFailStreak >= 5) incidents.push({ kind: "model-fail", summary: `模型调用连续失败 ${modelFailStreak} 次` });
  return { version, os: `${os.type()} ${os.release()} ${os.arch()}`, incidents };
}

/** 去掉 pid/uptime/日期这些每次都变的部分，让"同一个根因"能命中同一条。 */
export function stableSummary(text) {
  return String(text || "")
    .replace(/pid=\d+/gi, "pid=*")
    .replace(/uptime=\d+s?/gi, "uptime=*")
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?/g, "<time>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** 有可上报的异常吗（且有当日余量、开关开着） */
export function shouldReport(agentDir, incidents) {
  const st = loadState(agentDir);
  if (!st.enabled) return { ok: false, reason: "disabled" };
  if (!incidents.incidents.length) return { ok: false, reason: "nothing" };
  const today = new Date().toDateString();
  const sentToday = (st.sent || []).filter(s => new Date(s.at).toDateString() === today && s.kind !== "test").length;
  if (sentToday >= MAX_PER_DAY) return { ok: false, reason: "daily_limit" };
  // 去重：同 kind+summary 的 7 天内已发过就不重发。
  // 2026-10-25：summary 里带 pid 和 uptime，每次重启都是新串 → 去重形同虚设（真机刷了 20 条同根因）。
  // 这里把可变部分抹掉再比。
  const key = incidents.incidents.map(i => `${i.kind}:${stableSummary(i.summary)}`).join("|");
  if ((st.sent || []).some(s => s.key === key)) return { ok: false, reason: "duplicate" };
  return { ok: true, st };
}

/** 整理并发送。返回 { sent, kind } 或 { sent: false, reason }。 */
export async function reportIncidents(agentDir, incidents, { fetch: f = globalThis.fetch, endpoint = DEV_FEEDBACK_URL } = {}) {
  const gate = shouldReport(agentDir, incidents);
  if (!gate.ok) return { sent: false, reason: gate.reason };
  const payload = {
    type: "bug",
    title: `[自动上报] ${incidents.incidents[0].kind}: ${incidents.incidents[0].summary}`.slice(0, 120),
    detail: incidents.incidents.map(i => `· ${i.kind}: ${i.summary}`).join("\n") + (incidents.version ? `\n版本: v${incidents.version}` : ""),
    withDiagnostics: false, // 自动上报只发上面整理的事实，不带 crash 原文（避免夹带路径/内容）
    contact: "auto-telemetry",
  };
  const res = await f(endpoint, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(payload) });
  if (!res.ok) return { sent: false, reason: `http_${res.status}` };
  const st = gate.st;
  st.sent = st.sent || [];
  st.sent.push({ at: Date.now(), kind: incidents.incidents[0].kind, key: incidents.incidents.map(i => `${i.kind}:${i.summary}`).join("|") });
  saveState(agentDir, st);
  return { sent: true };
}

export function setEnabled(agentDir, enabled) {
  const st = loadState(agentDir);
  st.enabled = !!enabled;
  saveState(agentDir, st);
  return { enabled: st.enabled };
}
export function isEnabled(agentDir) { return loadState(agentDir).enabled !== false; }
