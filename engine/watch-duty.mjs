// ===== watch-duty.mjs —— 值班程序（2026-11-07）=====
//
// 她给自己写一条「盯梢」：长期盯一件事，只在真的命中时才叫醒她。
// 这是 Comma 那套「Agent 自己写值班程序，用户退出客户端、模型不跑时也守着，关键时刻唤醒 Agent」的落地。
//
// 核心分工（必须守住）：
//   值守 = 确定性检查（命令退出码/正则、HTTP 状态码/正文、文件 mtime/大小/关键字、到点）；
//   唤醒 = 命中且过完闸门之后，交回 job-pool 跑一轮 prompt —— 唯一会花模型的地方。
//
// 四条硬规矩：
//   ① 未命中零模型调用：本文件不 import 任何模型/对话模块，判定全是纯函数（judgeCmd/judgeHttp/judgeFile/judgeTime）。
//      唤醒函数 wake 由外面注入，本文件连它的实现都看不见。
//   ② 活过重启：状态落 记忆/运行时/值班.json；重启后每条活跃 watch **最多补查一次**（不按错过次数补，避免雪崩）。
//   ③ 限流与兜底：intervalMs 下限 60s、cooldownMs、dailyCap；命中还要过 proactive 的主动预算（readBudget/spendBudget）
//      和 0–7 点免打扰，预算不够只记日志不推送。
//   ④ 安全：kind:'cmd' 的命令先过 security.mjs 的宪法 deny 规则、危险命令表，再过 yuanshu-sandbox.mjs 的沙箱闸门；
//      deny 永远优先；后台通道没人能当场批 → fail-closed。这里不跑任何 JS eval（没有 new Function、不 import vm）。
//
// 不自造调度器：tick 只是确定性检查的节拍；真正的「唤醒执行」统一走注入的 wake（server 侧 = job-pool）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { atomicWriteJson } from "./atomic-io.mjs";
import { matchDenyRule, DANGEROUS_CMD_RE } from "./tools/security.mjs";
import { checkSandboxCall } from "./yuanshu-sandbox.mjs";
import { createTimeEngine } from "./time-engine.mjs";
import { readBudget, spendBudget, isQuietHours } from "./proactive.mjs";

export const WATCH_FILE_REL = path.join("记忆", "运行时", "值班.json");
export const WATCH_LOG_REL = path.join("记忆", "运行时", "值班日志.jsonl");

// ── 限流常数（写死在这里，别让模型随手改成 1 秒一次）──
export const KINDS = ["cmd", "http", "file", "time"];
export const MIN_INTERVAL_MS = 60_000;                 // 单条 watch 的最短检查间隔：60 秒
export const DEFAULT_INTERVAL_MS = 5 * 60_000;         // 默认 5 分钟
export const DEFAULT_COOLDOWN_MS = 30 * 60_000;        // 默认冷却 30 分钟
export const DEFAULT_DAILY_CAP = 12;                   // 每条 watch 每天最多唤醒 12 次
export const MAX_DAILY_CAP = 100;
export const MAX_ACTIVE_WATCHES = 10;                  // 同时活跃的 watch 上限
export const TICK_MS = 15_000;                         // 检查节拍（最短间隔 60s，15s 节拍足够）
export const CMD_TIMEOUT_MS = 20_000;
export const HTTP_TIMEOUT_MS = 10_000;
export const CMD_OUTPUT_CAP = 64 * 1024;
export const HTTP_BODY_CAP = 200_000;
export const FILE_READ_CAP = 512 * 1024;
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

const FILE_MODES = ["changed", "appeared", "disappeared", "contains", "size_gt"];

// time-engine 的 isDue 没有单独导出：这里用一个**从不 start** 的实例把它包出来复用，
// 复用的是既有 cron 语义（daily/weekly/once 与本地日历），一行 time-engine 内部代码都不改。
const timeProbe = createTimeEngine(null, { file: path.join(os.tmpdir(), "yuanshu-watch-time-probe.json") });

// ───────────────────────────── 小工具 ─────────────────────────────

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const tail = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : `…${t.slice(-n)}`;
};
/** 主动预算的「天」与冷会话唤醒用同一个键（UTC 日期），共用一个预算池。 */
export function budgetDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** 限制值归一：intervalMs 下限 60s，cooldown 不小于 60s，dailyCap 1–100。 */
export function clampLimits({ intervalMs, intervalSec, cooldownMs, cooldownSec, dailyCap } = {}) {
  const notes = [];
  let interval = Number(intervalMs);
  if (!Number.isFinite(interval) && Number.isFinite(Number(intervalSec))) interval = Number(intervalSec) * 1000;
  if (!Number.isFinite(interval) || interval <= 0) interval = DEFAULT_INTERVAL_MS;
  if (interval < MIN_INTERVAL_MS) {
    notes.push(`intervalMs 最小 ${MIN_INTERVAL_MS}（60 秒），已按 60 秒处理`);
    interval = MIN_INTERVAL_MS;
  }
  let cooldown = Number(cooldownMs);
  if (!Number.isFinite(cooldown) && Number.isFinite(Number(cooldownSec))) cooldown = Number(cooldownSec) * 1000;
  if (!Number.isFinite(cooldown) || cooldown < 0) cooldown = DEFAULT_COOLDOWN_MS;
  if (cooldown < MIN_INTERVAL_MS) {
    notes.push(`cooldownMs 最小 ${MIN_INTERVAL_MS}（60 秒），已按 60 秒处理`);
    cooldown = MIN_INTERVAL_MS;
  }
  let cap = Number(dailyCap);
  if (!Number.isFinite(cap) || cap <= 0) cap = DEFAULT_DAILY_CAP;
  cap = Math.min(MAX_DAILY_CAP, Math.max(1, Math.round(cap)));
  return { intervalMs: Math.round(interval), cooldownMs: Math.round(cooldown), dailyCap: cap, notes };
}

// ─────────────────────── 四种 kind 的 spec 校验 ───────────────────────

/** 校验并归一 spec。返回 {ok, spec} 或 {ok:false, error}（中文原因，直接给模型看）。 */
export function normalizeSpec(kind, rawSpec = {}) {
  const k = String(kind || "").trim();
  if (!KINDS.includes(k)) return { ok: false, error: `kind 只能是 ${KINDS.join(" / ")}` };
  let spec = rawSpec;
  if (typeof spec === "string") {
    try { spec = JSON.parse(spec); } catch { return { ok: false, error: "spec 不是合法 JSON" }; }
  }
  if (!spec || typeof spec !== "object") return { ok: false, error: "spec 必须是对象" };

  if (k === "cmd") {
    const command = String(spec.command || "").trim();
    if (!command) return { ok: false, error: "cmd 需要 spec.command（要跑的那条命令）" };
    if (command.length > 2000) return { ok: false, error: "命令太长（上限 2000 字符）" };
    const expectExit = (Array.isArray(spec.expectExit) ? spec.expectExit : [spec.expectExit == null ? 0 : spec.expectExit])
      .map(Number).filter(Number.isFinite);
    if (!expectExit.length) return { ok: false, error: "expectExit 需要数字或数字数组" };
    const stdoutRegex = String(spec.stdoutRegex || "");
    if (stdoutRegex) { try { new RegExp(stdoutRegex); } catch { return { ok: false, error: "stdoutRegex 不是合法正则" }; } }
    const timeoutMs = Math.min(60_000, Math.max(1_000, Number(spec.timeoutMs) || CMD_TIMEOUT_MS));
    return {
      ok: true,
      spec: {
        command,
        expectExit,
        stdoutIncludes: String(spec.stdoutIncludes || ""),
        stdoutRegex,
        stderrIncludes: String(spec.stderrIncludes || ""),
        timeoutMs,
      },
    };
  }

  if (k === "http") {
    const url = String(spec.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: "http 需要 spec.url，且必须是 http:// 或 https://" };
    const method = String(spec.method || "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method)) return { ok: false, error: "method 只支持 GET / HEAD" };
    const expectStatus = (Array.isArray(spec.expectStatus) ? spec.expectStatus : [spec.expectStatus == null ? 200 : spec.expectStatus])
      .map(Number).filter(Number.isFinite);
    if (!expectStatus.length) return { ok: false, error: "expectStatus 需要数字或数字数组" };
    const timeoutMs = Math.min(60_000, Math.max(1_000, Number(spec.timeoutMs) || HTTP_TIMEOUT_MS));
    return {
      ok: true,
      spec: {
        url,
        method,
        expectStatus,
        contains: asArray(spec.contains).map(String).filter(Boolean).slice(0, 5),
        notContains: asArray(spec.notContains).map(String).filter(Boolean).slice(0, 5),
        timeoutMs,
      },
    };
  }

  if (k === "file") {
    const p = String(spec.path || "").trim();
    if (!p) return { ok: false, error: "file 需要 spec.path（要盯的文件路径）" };
    const mode = String(spec.mode || "changed");
    if (!FILE_MODES.includes(mode)) return { ok: false, error: `file.mode 只能是 ${FILE_MODES.join(" / ")}` };
    if (mode === "contains" && !String(spec.contains || "")) return { ok: false, error: "mode=contains 需要 spec.contains（内容关键字）" };
    if (mode === "size_gt" && !(Number(spec.sizeGt) > 0)) return { ok: false, error: "mode=size_gt 需要 spec.sizeGt（字节数，> 0）" };
    return {
      ok: true,
      spec: { path: p, mode, contains: String(spec.contains || ""), sizeGt: Number(spec.sizeGt) || 0 },
    };
  }

  // time：只存 time-engine 认的字段，语义完全复用它的 isDue
  const type = String(spec.type || "daily");
  if (!["daily", "weekly", "once"].includes(type)) return { ok: false, error: "time.type 只能是 daily / weekly / once" };
  const at = String(spec.at || "").trim();
  if (!/^\d{2}:\d{2}$/.test(at)) return { ok: false, error: "time.at 格式应为 HH:MM（如 09:00）" };
  const day = spec.day == null ? null : Number(spec.day);
  if (type === "weekly" && !(day >= 1 && day <= 7)) return { ok: false, error: "time.type=weekly 需要 day（1-7，周一=1）" };
  const date = type === "once" ? String(spec.date || "") : null;
  if (type === "once" && !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return { ok: false, error: "time.type=once 需要 date（YYYY-MM-DD）" };
  return { ok: true, spec: { type, at, day: type === "weekly" ? day : null, date } };
}

// ───────────────────────── 判定函数（纯函数）─────────────────────────
// 这些函数只吃「观测值 + spec」，不看时间、不读盘、不调模型 —— 值班的成本就在这里被钉死。

/** kind:'cmd' —— 按退出码 / 输出子串 / 输出正则判定。 */
export function judgeCmd(spec = {}, obs = {}) {
  if (obs?.timedOut) return { hit: false, reason: "命令超时（已终止），不算命中" };
  if (obs?.blocked) return { hit: false, blocked: true, reason: `命令被策略拒绝：${obs.error || "未执行"}` };
  const exit = Number(obs?.exitCode);
  const expects = asArray(spec.expectExit ?? 0).map(Number);
  if (!expects.includes(exit)) return { hit: false, reason: `退出码 ${Number.isFinite(exit) ? exit : "未知"}，期望 ${expects.join(" / ")}` };
  const stdout = String(obs?.stdout || "");
  if (spec.stdoutIncludes && !stdout.includes(spec.stdoutIncludes)) {
    return { hit: false, reason: `退出码 ${exit}，但输出里没有「${spec.stdoutIncludes}」` };
  }
  if (spec.stdoutRegex) {
    let re;
    try { re = new RegExp(spec.stdoutRegex, "m"); } catch { return { hit: false, reason: "stdoutRegex 不是合法正则" }; }
    if (!re.test(stdout)) return { hit: false, reason: `退出码 ${exit}，但输出不匹配 /${spec.stdoutRegex}/` };
  }
  if (spec.stderrIncludes && !String(obs?.stderr || "").includes(spec.stderrIncludes)) {
    return { hit: false, reason: `stderr 里没有「${spec.stderrIncludes}」` };
  }
  const bits = [`退出码 ${exit}`];
  if (spec.stdoutIncludes) bits.push(`输出含「${spec.stdoutIncludes}」`);
  if (spec.stdoutRegex) bits.push(`输出匹配 /${spec.stdoutRegex}/`);
  return { hit: true, reason: bits.join("，") };
}

/** kind:'http' —— 按状态码 / 正文关键字判定。 */
export function judgeHttp(spec = {}, obs = {}) {
  if (obs?.error) return { hit: false, reason: `请求失败：${obs.error}` };
  const status = Number(obs?.status);
  const expects = asArray(spec.expectStatus ?? 200).map(Number);
  if (!expects.includes(status)) return { hit: false, reason: `HTTP ${Number.isFinite(status) ? status : "未知"}，期望 ${expects.join(" / ")}` };
  const body = String(obs?.body || "");
  for (const need of asArray(spec.contains)) {
    if (!body.includes(need)) return { hit: false, reason: `HTTP ${status}，但正文不含「${need}」` };
  }
  for (const bad of asArray(spec.notContains)) {
    if (body.includes(bad)) return { hit: false, reason: `HTTP ${status}，但正文出现了不该有的「${bad}」` };
  }
  const need = asArray(spec.contains);
  return { hit: true, reason: `HTTP ${status}${need.length ? ` 且正文含 ${need.map((x) => `「${x}」`).join("")}` : ""}` };
}

/**
 * kind:'file' —— 盯 mtime/大小变化、出现/消失、内容关键字、大小阈值。
 * 变化类（changed/appeared/disappeared）第一次观察只建基线，不触发（否则一建就响）。
 */
export function judgeFile(spec = {}, obs = {}, prev = null) {
  const exists = obs?.exists === true;
  const snapshot = { exists, mtimeMs: Number(obs?.mtimeMs) || 0, size: Number(obs?.size) || 0 };
  const mode = spec.mode || "changed";

  // 绝对条件：不看基线，只看此刻是否成立
  if (mode === "contains") {
    if (!exists) return { hit: false, reason: "文件不存在", snapshot };
    const text = String(obs?.content ?? "");
    const hit = text.includes(String(spec.contains || ""));
    return { hit, reason: hit ? `文件里出现了「${spec.contains}」` : `文件里还没有「${spec.contains}」`, snapshot };
  }
  if (mode === "size_gt") {
    if (!exists) return { hit: false, reason: "文件不存在", snapshot };
    const hit = snapshot.size > Number(spec.sizeGt || 0);
    return { hit, reason: hit ? `大小 ${snapshot.size} 超过 ${spec.sizeGt}` : `大小 ${snapshot.size} 未超过 ${spec.sizeGt}`, snapshot };
  }

  // 变化类：没有基线 = 首次观察，只记基线
  if (!prev) return { hit: false, reason: "首次观察（只建基线，不触发）", snapshot, baseline: true };

  if (mode === "changed") {
    // "变了"包括出现/消失：出现/消失另有窄口径 mode，但 changed 也把它们算作变化
    const hit = exists !== (prev.exists === true)
      || (exists && prev.exists === true
        && (snapshot.mtimeMs !== Number(prev.mtimeMs || 0) || snapshot.size !== Number(prev.size || 0)));
    const reason = !exists ? (prev.exists === true ? "文件不见了（也算变化）" : "文件不存在")
      : prev.exists !== true ? "文件出现了（也算变化）" : hit ? "文件有变化（mtime/大小）" : "文件没变化";
    return { hit, reason, snapshot };
  }
  if (mode === "appeared") {
    const hit = exists && prev.exists !== true;
    return { hit, reason: hit ? "文件出现了" : exists ? "文件在，但不是刚出现" : "文件还没出现", snapshot };
  }
  if (mode === "disappeared") {
    const hit = !exists && prev.exists === true;
    return { hit, reason: hit ? "文件不见了" : exists ? "文件还在" : "文件本来就不在", snapshot };
  }
  return { hit: false, reason: `未知 mode ${mode}`, snapshot };
}

/** kind:'time' —— 到点即触发；语义直接复用 time-engine 的 isDue（包一层，不改它内部）。 */
export function judgeTime(spec = {}, { now = Date.now(), lastFiredAt = 0, createdAt = 0 } = {}) {
  const task = {
    state: "active",
    type: spec.type,
    at: spec.at,
    day: spec.day ?? null,
    date: spec.date ?? null,
    created: createdAt ? new Date(createdAt).toISOString() : null,
    lastRun: lastFiredAt ? new Date(lastFiredAt).toISOString() : null,
  };
  let due = false;
  try { due = timeProbe._isDue(task, new Date(now)) === true; } catch { due = false; }
  const label = spec.type === "once" ? `${spec.date} ${spec.at}` : spec.type === "weekly" ? `每周 ${spec.day} ${spec.at}` : `每天 ${spec.at}`;
  return { hit: due, reason: due ? `到点（${label}）` : `还没到点（${label}）` };
}

// ─────────────────────── 命令安全闸门（deny 永远优先）───────────────────────

// 受保护文件被写：只做粗判（真正的只读保证在工具层），这里拦住"值班程序被注入去改人格/宪法/凭据"。
const PROTECTED_NAME_RE = /(APPEND_SYSTEM\.md|[\\/\s"']SOUL(?![A-Za-z])|[\\/\s"']IDENTITY(?![A-Za-z])|宪法\.json|人格定义\.json|\.token(?![A-Za-z]))/i;
const WRITE_HINT_RE = /(>>?|\bOut-File\b|\bSet-Content\b|\bAdd-Content\b|\bNew-Item\b|\bcopy\b|\bmove\b|\bRemove-Item\b|\bdel\b|\brm\b)/i;

/**
 * 执行前的策略检查：宪法 deny → 危险命令 → 沙箱闸门 → 受保护文件只读。
 * 返回 {ok:true} 才允许 spawn；任何一层不过都 fail-closed。
 */
export function preflightCommand(command, { wsRoot = "" } = {}) {
  const cmd = String(command || "").trim();
  if (!cmd) return { ok: false, denied: true, reason: "命令为空" };

  // ① User 层 deny（宪法红线）：deny 永远赢，先于一切 allow
  const deny = matchDenyRule(cmd);
  if (deny) return { ok: false, denied: true, rule: deny.id, reason: `命中宪法红线 [${deny.id}]，值班程序也不能绕` };

  // ② 不可逆危险命令
  if (DANGEROUS_CMD_RE.test(cmd)) {
    return { ok: false, denied: true, rule: "dangerous-cmd", reason: "命中危险命令表（可能造成不可逆数据丢失），拒绝执行" };
  }

  // ③ 沙箱闸门（yuanshu-sandbox）：后台通道没有应答者，需要升级的一律 fail-closed
  const gate = checkSandboxCall({ mode: "workspace-write", name: "bash", args: { command: cmd }, wsRoot });
  if (!gate.ok) {
    return { ok: false, denied: true, rule: "sandbox", reason: gate.note || `沙箱拒绝（当前 ${gate.tag || "workspace-write"}）` };
  }

  // ④ 受保护文件只读（人格/宪法/凭据）：带写意图就拒绝
  if (WRITE_HINT_RE.test(cmd) && PROTECTED_NAME_RE.test(cmd)) {
    return { ok: false, denied: true, rule: "protected-path", reason: "受保护文件（人格/宪法/凭据）只读，不允许通过值班命令写" };
  }

  return { ok: true, mode: gate.mode };
}

// ───────────────────────────── 观测器 ─────────────────────────────
// 三个默认观测器都有超时与输出上限；测试里可以整体替换（probes）。

/** 跑一条命令。先过 preflightCommand；被拒时**不 spawn**，直接返回 blocked。 */
export function probeCmd(spec = {}, { wsRoot = "" } = {}) {
  const check = preflightCommand(spec.command, { wsRoot });
  if (!check.ok) return Promise.resolve({ blocked: true, error: check.reason, exitCode: null, stdout: "", stderr: "" });
  const timeoutMs = Math.min(60_000, Math.max(1_000, Number(spec.timeoutMs) || CMD_TIMEOUT_MS));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, { cwd: wsRoot || process.cwd(), shell: true, windowsHide: true, env: process.env });
    } catch (e) {
      resolve({ blocked: false, exitCode: null, stdout: "", stderr: "", error: String(e?.message || e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: stdout.slice(0, CMD_OUTPUT_CAP), stderr: stderr.slice(0, CMD_OUTPUT_CAP), timedOut, error });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* 已经退出 */ }
      finish(null, "timeout");
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (d) => { if (stdout.length < CMD_OUTPUT_CAP) stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d) => { if (stderr.length < CMD_OUTPUT_CAP) stderr += d.toString("utf8"); });
    child.on("error", (e) => finish(null, String(e?.message || e)));
    child.on("close", (code) => finish(code == null ? null : Number(code), ""));
  });
}

/** GET 一个 URL（只读，超时 10s，正文截断）。 */
export async function probeHttp(spec = {}) {
  const timeoutMs = Math.min(60_000, Math.max(1_000, Number(spec.timeoutMs) || HTTP_TIMEOUT_MS));
  try {
    const res = await fetch(spec.url, { method: spec.method || "GET", signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { status: res.status, body: String(text || "").slice(0, HTTP_BODY_CAP) };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 300) };
  }
}

/** 看一个文件：mtime/大小；mode=contains 时把内容也读回来（有上限）。 */
export async function probeFile(spec = {}, { wsRoot = "" } = {}) {
  const target = path.isAbsolute(String(spec.path || ""))
    ? String(spec.path)
    : path.resolve(wsRoot || process.cwd(), String(spec.path || ""));
  try {
    const st = fs.statSync(target);
    const obs = { exists: true, size: st.size, mtimeMs: st.mtimeMs };
    if (spec.mode === "contains") {
      const fd = fs.openSync(target, "r");
      try {
        const buf = Buffer.alloc(Math.min(FILE_READ_CAP, st.size));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        obs.content = buf.slice(0, n).toString("utf8");
      } finally { fs.closeSync(fd); }
    }
    return obs;
  } catch {
    return { exists: false };
  }
}

// ───────────────────────────── 日志 ─────────────────────────────

/** 追加一行 JSONL 值班日志；文件超过 2MB 就轮换成 .1（不无限长）。 */
export function appendWatchLog(logFile, entry, now = Date.now()) {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try {
      const st = fs.statSync(logFile);
      if (st.size > LOG_MAX_BYTES) {
        const bak = `${logFile}.1`;
        try { fs.rmSync(bak, { force: true }); } catch { /* 忽略 */ }
        fs.renameSync(logFile, bak);
      }
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(logFile, `${JSON.stringify({ at: now, ...entry })}\n`, "utf8");
  } catch { /* 日志写不进去不该影响值守 */ }
}

// ───────────────────────────── 值班实例 ─────────────────────────────

/**
 * 创建值班程序实例。
 * 注入项：wake（命中后的唤醒，唯一会花模型的地方）、probes（观测器，测试可替换）、now（时钟）。
 */
export function createWatchDuty({
  wsRoot = ".",
  file = path.join(String(wsRoot || "."), WATCH_FILE_REL),
  logFile = path.join(String(wsRoot || "."), WATCH_LOG_REL),
  wake = null,
  probes = {},
  now = () => Date.now(),
  log = console,
  budgetCap = 3,
  tickMs = TICK_MS,
  quiet = true,
  maxActive = MAX_ACTIVE_WATCHES,
} = {}) {
  const clock = typeof now === "function" ? now : () => Number(now);
  const probe = { cmd: probeCmd, http: probeHttp, file: probeFile, ...probes };
  let watches = [];
  let timer = null;
  let ticking = false;
  let dirty = false;
  let lastTickAt = 0;

  // ── 落盘 ──
  function persist() {
    try {
      atomicWriteJson(file, { v: 1, updatedAt: clock(), watches });
      dirty = false;
    } catch (e) { log.warn?.(`[watch-duty] 状态落盘失败：${String(e?.message || e).slice(0, 120)}`); }
  }
  function logEvent(entry) { appendWatchLog(logFile, entry, clock()); }

  function load() {
    try {
      if (!fs.existsSync(file)) return { loaded: 0 };
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      const list = Array.isArray(doc?.watches) ? doc.watches : Array.isArray(doc) ? doc : [];
      watches = list.filter((w) => w && w.id && KINDS.includes(w.kind)).map((w) => {
        // state 只存生命周期字符串（active/paused，与 time-engine 的任务状态一致）；
        // 早期草稿里 state 曾是对象，这里做一次兼容迁移，运行时数据统一落到 runtime。
        const legacy = w.state && typeof w.state === "object" ? w.state : null;
        const state = typeof w.state === "string" ? w.state : legacy?.mode === "paused" ? "paused" : "active";
        const runtime = { ...(w.runtime || legacy || {}) };
        return {
          ...w,
          intervalMs: Number(w.intervalMs) || DEFAULT_INTERVAL_MS,
          cooldownMs: Number(w.cooldownMs) || DEFAULT_COOLDOWN_MS,
          dailyCap: Number(w.dailyCap) || DEFAULT_DAILY_CAP,
          state,
          runtime: {
            createdAt: 0, updatedAt: 0, lastCheckAt: 0, lastHitAt: 0, lastWakeAt: 0, lastTriggerAt: 0, lastFiredAt: 0,
            checkCount: 0, hitCount: 0, wakeCount: 0, counters: { day: "", wakes: 0 }, baseline: null, last: null,
            ...runtime,
            counters: { day: "", wakes: 0, ...(runtime.counters || {}) },
          },
        };
      });
      return { loaded: watches.length };
    } catch (e) {
      log.warn?.(`[watch-duty] 状态文件损坏，按空处理：${String(e?.message || e).slice(0, 120)}`);
      watches = [];
      return { loaded: 0, error: String(e?.message || e) };
    }
  }

  // 构造即读取：重启后任何 API/清单都能立刻看到旧状态，不必等 start()
  load();

  function publicWatch(w) {
    const s = w.runtime || {};
    const day = budgetDay(clock());
    return {
      id: w.id, name: w.name, kind: w.kind, spec: w.spec, prompt: w.prompt,
      intervalMs: w.intervalMs, cooldownMs: w.cooldownMs, dailyCap: w.dailyCap,
      state: w.state === "paused" ? "paused" : "active",
      runtime: s,
      wakesToday: s.counters?.day === day ? Number(s.counters?.wakes || 0) : 0,
      nextCheckAt: w.state === "active" && s.lastCheckAt ? Number(s.lastCheckAt) + w.intervalMs : null,
    };
  }

  // ── 增删改查 ──
  function create(input = {}) {
    const name = String(input.name || "").trim().slice(0, 60);
    if (!name) return { ok: false, error: "name 不能为空（给这条值班起个名字）" };
    const kind = String(input.kind || "").trim();
    const normalized = normalizeSpec(kind, input.spec || {});
    if (!normalized.ok) return { ok: false, error: normalized.error };
    const prompt = String(input.prompt || "").trim();
    if (!prompt) return { ok: false, error: "prompt 不能为空：命中后要跑的那句话" };
    if (prompt.length > 4000) return { ok: false, error: "prompt 太长（上限 4000 字）" };

    const limits = clampLimits(input);
    const active = watches.filter((w) => w.state === "active").length;
    if (active >= maxActive) {
      return { ok: false, error: `同时活跃的值班最多 ${maxActive} 条（现在 ${active} 条）。先暂停或删除一条，再建新的。` };
    }

    const t = clock();
    const watch = {
      id: `wt-${randomUUID().slice(0, 8)}`,
      name,
      kind,
      spec: normalized.spec,
      prompt,
      intervalMs: limits.intervalMs,
      cooldownMs: limits.cooldownMs,
      dailyCap: limits.dailyCap,
      // state = 生命周期（active ⇄ paused）；runtime = 运行时数据（最近检查/命中/唤醒、计数、基线）
      state: "active",
      runtime: {
        createdAt: t, updatedAt: t,
        lastCheckAt: 0, lastHitAt: 0, lastWakeAt: 0, lastTriggerAt: 0, lastFiredAt: 0,
        checkCount: 0, hitCount: 0, wakeCount: 0,
        counters: { day: "", wakes: 0 },
        baseline: null,
        last: null,
      },
    };
    watches.push(watch);
    dirty = true;
    persist();
    logEvent({ event: "create", watchId: watch.id, name, kind, notes: limits.notes });
    log.log?.(`[watch-duty] 新建值班 ${watch.id}「${name}」（${kind}，每 ${Math.round(watch.intervalMs / 1000)}s 检查一次）`);
    return { ok: true, id: watch.id, watch: publicWatch(watch), notes: limits.notes };
  }

  function get(id) {
    const w = watches.find((x) => x.id === String(id || ""));
    return w ? publicWatch(w) : null;
  }

  function list() { return watches.map(publicWatch); }

  function summary() {
    return {
      total: watches.length,
      active: watches.filter((w) => w.state === "active").length,
      paused: watches.filter((w) => w.state !== "active").length,
      maxActive,
      tickMs,
      running: !!timer,
      lastTickAt: lastTickAt || null,
      file,
      logFile,
    };
  }

  function setMode(id, mode) {
    const w = watches.find((x) => x.id === String(id || ""));
    if (!w) return { ok: false, error: `没有这条值班：${id}` };
    if (mode === "active" && w.state !== "active") {
      const active = watches.filter((x) => x.state === "active").length;
      if (active >= maxActive) return { ok: false, error: `活跃的值班已经到上限 ${maxActive} 条，先暂停一条再恢复` };
    }
    if (w.state === mode) return { ok: true, id: w.id, state: mode, unchanged: true };
    w.state = mode;
    w.runtime.updatedAt = clock();
    dirty = true;
    persist();
    logEvent({ event: mode === "paused" ? "pause" : "resume", watchId: w.id, name: w.name });
    return { ok: true, id: w.id, state: mode };
  }
  const pause = (id) => setMode(id, "paused");
  const resume = (id) => setMode(id, "active");

  function remove(id) {
    const target = String(id || "");
    const w = watches.find((x) => x.id === target);
    if (!w) return { ok: false, removed: false, error: `没有这条值班：${id}` };
    watches = watches.filter((x) => x.id !== target);
    dirty = true;
    persist();
    logEvent({ event: "delete", watchId: w.id, name: w.name });
    return { ok: true, removed: true, id: w.id };
  }

  // ── 单条检查：只做确定性观测 + 纯函数判定（这里不碰模型）──
  async function observe(w, t) {
    try {
      if (w.kind === "cmd") {
        const obs = await probe.cmd(w.spec, { wsRoot, now: t });
        const verdict = judgeCmd(w.spec, obs || {});
        return { verdict, detail: { exitCode: obs?.exitCode ?? null, stdout: tail(obs?.stdout, 800), stderr: tail(obs?.stderr, 400) } };
      }
      if (w.kind === "http") {
        const obs = await probe.http(w.spec, { wsRoot, now: t });
        const verdict = judgeHttp(w.spec, obs || {});
        return { verdict, detail: { status: obs?.status ?? null, excerpt: tail(obs?.body, 800) } };
      }
      if (w.kind === "file") {
        const obs = await probe.file(w.spec, { wsRoot, now: t });
        const verdict = judgeFile(w.spec, obs || {}, w.runtime.baseline);
        return { verdict, detail: { path: w.spec.path, snapshot: verdict.snapshot } };
      }
      if (w.kind === "time") {
        const verdict = judgeTime(w.spec, { now: t, lastFiredAt: w.runtime.lastFiredAt, createdAt: w.runtime.createdAt });
        return { verdict, detail: { at: w.spec.at, type: w.spec.type } };
      }
      return { verdict: { hit: false, reason: `未知 kind：${w.kind}` }, detail: {} };
    } catch (e) {
      return { verdict: { hit: false, error: String(e?.message || e).slice(0, 300) }, detail: {} };
    }
  }

  async function runWatch(w, t, summaryOut) {
    const { verdict, detail } = await observe(w, t);
    w.runtime.lastCheckAt = t;
    w.runtime.checkCount = Number(w.runtime.checkCount || 0) + 1;
    w.runtime.updatedAt = t;
    w.runtime.last = { hit: verdict.hit === true, reason: verdict.reason || verdict.error || "", at: t };
    dirty = true;
    summaryOut.checked += 1;

    if (verdict.error) {
      summaryOut.errors += 1;
      logEvent({ event: "error", watchId: w.id, error: verdict.error });
      return;
    }
    if (verdict.blocked) {
      // 命令被 deny / 沙箱拦住：留证据，但不算命中、不唤醒
      logEvent({ event: "blocked", watchId: w.id, name: w.name, reason: verdict.reason });
      return;
    }

    // ★ 零模型调用的分界线 ★
    // 未命中 → 到这里就返回。本文件没有任何模型调用；wake（真正花模型的那一步）只在下面所有闸门都过了才会被调用。
    if (!verdict.hit) return;

    w.runtime.lastHitAt = t;
    w.runtime.hitCount = Number(w.runtime.hitCount || 0) + 1;
    // time 类：命中的这一刻就把"这个点已经用过"记下来，避免同一个点每 15 秒重复触发
    if (w.kind === "time") w.runtime.lastFiredAt = t;
    summaryOut.hits += 1;
    logEvent({ event: "hit", watchId: w.id, name: w.name, kind: w.kind, reason: verdict.reason, detail });

    const suppress = (reason, extra = {}) => {
      summaryOut.suppressed += 1;
      w.runtime.last.suppressed = reason;
      logEvent({ event: "suppressed", watchId: w.id, name: w.name, reason, ...extra });
    };

    // 闸门 ①：冷却（同一件事别连着叫；锚点 = 上次触发，含被预算/免打扰拦下的那次）
    const lastWake = Number(w.runtime.lastTriggerAt || w.runtime.lastWakeAt) || 0;
    if (lastWake && t - lastWake < w.cooldownMs) {
      suppress("cooldown", { sinceMs: t - lastWake, cooldownMs: w.cooldownMs });
      return;
    }
    // 过了冷却闸门就记一次触发：后面即使被日限/免打扰/预算拦下，也不会每个检查周期都重记一遍
    w.runtime.lastTriggerAt = t;

    // 闸门 ②：每条 watch 的每日上限
    const day = budgetDay(t);
    if (w.runtime.counters?.day !== day) w.runtime.counters = { day, wakes: 0 };
    if (Number(w.runtime.counters.wakes || 0) >= w.dailyCap) {
      suppress("daily_cap", { wakes: w.runtime.counters.wakes, dailyCap: w.dailyCap });
      return;
    }

    // 闸门 ③：免打扰时段（0–7 点）——不叫醒，只记日志（这一条会被明天的检查重新判定）
    if (quiet && isQuietHours(t)) {
      suppress("quiet_hours", { hour: new Date(t).getHours() });
      return;
    }

    // 闸门 ④：主动预算（proactive 的 readBudget/spendBudget，和冷会话唤醒共用同一个池子）
    const budget = readBudget(wsRoot, day, { cap: budgetCap });
    if (budget.remaining <= 0) {
      suppress("budget", { used: budget.used, cap: budget.cap });
      return;
    }
    const spent = spendBudget(wsRoot, day, { cap: budget.cap, kind: "watch" });
    if (!spent.ok) {
      suppress("budget", { used: budget.used, cap: budget.cap, error: spent.error || spent.reason });
      return;
    }

    // ★ 唯一会花模型的调用点 ★：wake 由 server 注入（内部走 job-pool），本模块不知道模型是谁。
    let out = null;
    try {
      out = wake ? wake({ watch: publicWatch(w), hit: { reason: verdict.reason, detail, at: t } }) : { skipped: "wake_not_injected" };
    } catch (e) {
      summaryOut.errors += 1;
      w.runtime.lastWakeAt = t;
      logEvent({ event: "wake_failed", watchId: w.id, error: String(e?.message || e).slice(0, 300) });
      return;
    }
    w.runtime.lastWakeAt = t;
    w.runtime.counters.wakes = Number(w.runtime.counters.wakes || 0) + 1;
    w.runtime.wakeCount = Number(w.runtime.wakeCount || 0) + 1;
    summaryOut.wakes += 1;
    logEvent({ event: "wake", watchId: w.id, name: w.name, jobId: out?.jobId || "", reason: verdict.reason, used: spent.used, cap: spent.cap });
  }

  // ── 检查节拍 ──
  // catchUp=true 时每条活跃 watch 立刻补查一次（启动恢复用）；除此之外按 lastCheckAt+intervalMs 判定是否到期。
  async function tick({ catchUp = false } = {}) {
    if (ticking) return { ok: false, reason: "busy" };
    ticking = true;
    const t = clock();
    const out = { ok: true, at: t, catchUp: !!catchUp, checked: 0, hits: 0, wakes: 0, suppressed: 0, errors: 0 };
    try {
      for (const w of [...watches]) {
        if (w.state !== "active") continue;
        const last = Number(w.runtime.lastCheckAt) || 0;
        const due = catchUp || !last || t - last >= w.intervalMs;
        if (!due) continue;
        await runWatch(w, t, out);
        // 每条检查完就落盘：进程半路死掉，也不会把"已经查过/已经唤醒"忘掉
        persist();
      }
      lastTickAt = clock();
    } finally {
      ticking = false;
      if (dirty) persist();
    }
    return out;
  }

  function start() {
    if (timer) return { ok: true, already: true };
    logEvent({ event: "restore", watches: watches.length, active: watches.filter((w) => w.state === "active").length });
    timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
    timer.unref?.();
    // 重启补跑：每个活跃 watch 最多补一次（不是"错过 3 次就补 3 次"，避免一启动就雪崩）
    const missed = watches.filter((w) => w.state === "active" && (!w.runtime.lastCheckAt || clock() - w.runtime.lastCheckAt >= w.intervalMs)).length;
    if (missed) log.log?.(`[watch-duty] ${missed} 条值班错过了检查，启动后各补查一次`);
    void tick({ catchUp: true }).catch(() => {});
    return { ok: true, catchUp: missed };
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    start, stop, tick,
    create, get, list, summary, pause, resume, remove, setMode,
    // 给测试/诊断用的只读口
    _file: file, _logFile: logFile, _budgetDay: budgetDay,
  };
}
