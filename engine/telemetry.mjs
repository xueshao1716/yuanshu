// engine/telemetry.mjs —— 分发主机自动问题上报（2026-10-13）
// 场景：分发出去的元枢自己发现异常（服务 crash / 被重启 / 连续模型失败），
// 整理成结构化报告发回开发者，用户无感（技术事实，绝不含对话内容/个人数据）。
// 约束：①每日最多 3 条自动报告 ②只发规则模板提取的事实 ③开关可关 ④本机是工作台时不发（自己给自己发没意义）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildCrashReport, triageLine, diagnosability } from "./crash-report-spec.mjs";
import { newTicket, withTicket, ticketLine } from "./feedback-ticket.mjs";

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
    const code = exitCodeOf(exitLine);
    // 2026-10-26：原来只上报「one line, 160 字符」，结果分发的用户报回来的崩溃**没法定位**
    // （真机：`server.mjs:2314:28 <- at listOnTimeout` 后面全被截掉，看不出是哪段代码）。
    // 现在把异常附近的多行栈一起带上，并单独给 stack 字段。
    const exAt = crashTail.search(/uncaughtException:/i);
    if (exAt >= 0) {
      const block = crashTail.slice(exAt, exAt + 1400).trim();
      incidents.push({
        kind: "crash",
        summary: block.split("\n").slice(0, 12).join("\n").slice(0, 700),
        stack: block.slice(0, 1200),
        code: null,
      });
    } else if (exitLine && code !== 0) {
      // 没有异常栈：把退出行连同前后文一起带上
      const at = crashTail.lastIndexOf(exitLine);
      const around = crashTail.slice(Math.max(0, at - 400), at + exitLine.length + 400).trim();
      incidents.push({ kind: "crash", summary: exitLine.slice(0, 160), context: around.slice(0, 700), code });
    }
  }
  // 2026-10-26：按验收标准补一份结构化报告（能定位的字段全在这）
  const primary = incidents[0];
  if (primary) {
    const stack = primary.stack || primary.summary || "";
    primary.report = buildCrashReport({
      version, commit: process.env.YUANSHU_BUILD_COMMIT || "",
      platform: process.platform, arch: process.arch, node: process.version,
      uptimeSec: Math.round(process.uptime()), kind: primary.kind,
      signature: String(stack).split("\n").slice(0, 2).join(" | ").slice(0, 200),
      stack, exitCode: primary.code ?? null,
    });
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

/**
 * 上报台账（2026-10-26）：每次**决定**都留一行（sent / skipped + 原因 + 摘要）。
 * 为什么需要：43 条收件箱里 23 条假警报，事后完全不知道当时为什么判定成崩溃。
 * 台账只留最近 200 行，放 agentDir 下，不进上报内容。
 */
export const REPORT_LEDGER = "上报台账.jsonl";

export function recordReport(agentDir, entry = {}) {
  try {
    const file = path.join(agentDir, REPORT_LEDGER);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...entry }) + "\n", "utf8");
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > 200) fs.writeFileSync(file, lines.slice(-100).join("\n") + "\n", "utf8");
    return true;
  } catch { return false; }
}

export function readReportLedger(agentDir, { limit = 20 } = {}) {
  try {
    const file = path.join(agentDir, REPORT_LEDGER);
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse();
  } catch { return [] }
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
  if (!gate.ok) {
    recordReport(agentDir, { decision: "skipped", reason: gate.reason, kinds: (incidents.incidents || []).map(i => i.kind) });
    return { sent: false, reason: gate.reason };
  }
  // 2026-10-26：带工单号——回信时双方能对上号（公网端点不一定给回信地址，但号是我们自己的）
  let ticket = null;
  try { ticket = newTicket(agentDir); } catch {}
  const payload = withTicket({
    type: "bug",
    title: `[自动上报] ${incidents.incidents[0].kind}: ${incidents.incidents[0].summary}`.slice(0, 120),
    // 2026-10-26：把**能定位**的事实都带上——分发的用户报回来一次就该够用。
    // （参考真实报告：只给 "server.mjs:2314:28 <- at listOnTimeout" 这种截断行，等于没报。）
    detail: [
      ...incidents.incidents.map(i => `· ${i.kind}: ${i.summary}`),
      incidents.incidents.some(i => i.stack) ? `\n--- stack ---\n${incidents.incidents.find(i => i.stack).stack}` : "",
      incidents.incidents.some(i => i.context) ? `\n--- context ---\n${incidents.incidents.find(i => i.context).context}` : "",
      `\n--- env ---`,
      `版本: v${incidents.version || "?"}`,
      `系统: ${incidents.os || "?"}`,
      `node: ${process.version} (${process.platform}/${process.arch})`,
      `启动参数: ${process.argv.slice(0, 3).join(" ")}`,
      `\n[可定位性] ${incidents.incidents[0]?.report ? triageLine(incidents.incidents[0].report) : diagnosability(incidents.incidents[0]?.report || {}).level}`,
    ].filter(Boolean).join("\n").slice(0, 6000),
    // 2026-10-26：报告要能被"验收"——字段齐不齐、能不能定位、版本还支持吗
    env: incidents.incidents[0]?.report ? {
      version: incidents.incidents[0].report.version,
      commit: incidents.incidents[0].report.commit,
      platform: incidents.incidents[0].report.platform,
      arch: incidents.incidents[0].report.arch,
      node: incidents.incidents[0].report.node,
      uptimeSec: incidents.incidents[0].report.uptimeSec,
      signature: incidents.incidents[0].report.signature,
      exitCode: incidents.incidents[0].report.exitCode,
    } : null,
    triage: incidents.incidents[0]?.report ? triageLine(incidents.incidents[0].report) : null,
    withDiagnostics: false, // 不发 crash.log 原文全文（避免夹带工作区路径与内容）
    contact: "auto-telemetry",
    ticketId: ticket?.ticketId || "",
    installId: ticket?.installId || "",
  }, ticket && { replyTo: "" });
  if (ticket) payload.detail += "\n" + ticketLine(ticket);
  const res = await f(endpoint, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(payload) });
  if (!res.ok) {
    recordReport(agentDir, { decision: "failed", reason: `http_${res.status}`, kinds: incidents.incidents.map(i => i.kind) });
    return { sent: false, reason: `http_${res.status}` };
  }
  const st = gate.st;
  st.sent = st.sent || [];
  st.sent.push({ at: Date.now(), kind: incidents.incidents[0].kind, key: incidents.incidents.map(i => `${i.kind}:${i.summary}`).join("|") });
  saveState(agentDir, st);
  recordReport(agentDir, { decision: "sent", kinds: incidents.incidents.map(i => i.kind), title: payload.title.slice(0, 100) });
  return { sent: true };
}

export function setEnabled(agentDir, enabled) {
  const st = loadState(agentDir);
  st.enabled = !!enabled;
  saveState(agentDir, st);
  return { enabled: st.enabled };
}
export function isEnabled(agentDir) { return loadState(agentDir).enabled !== false; }
