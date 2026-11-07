// ===== watchdog-drift.mjs —— 看门狗升级：从"进程活着"到"有没有跑偏"（2026-11-02）=====
//
// 来源：DSH Super-agent 的 Watchdog——很多故障不是进程死了，而是 LLM 循环死锁或偏离目标。
// 这里只做判断（纯函数），不杀进程、不改行为；结果落台账，需要时再让人看。
//
// 2026-11-07：之前 issue 只有 {code, detail, n}，推送出去是「bash 连续失败 3 次」，
// 用户追问"哪个任务跑偏了"时谁也答不上来。现在每个 issue 都从窗口内**相关的 rows** 里
// 取身份（runId/sessionId/taskId）、时间范围、失败样例和可查 evidence；取不到就留空，不猜。
// 之后再补一层：run 记录里有人类可读的 title 就带上（rows 自查 → 注入的 titleOf 查 run store），
// 通知与 watchdog_read 才能说清「是哪件事」，而不只是 run id。
import fs from "node:fs";
import path from "node:path";

const text = (v) => (v == null ? "" : String(v).trim());

/** 取第一个非空字段（兼容审计门的历史字段名）。 */
function fieldOf(row, names) {
  for (const name of names) {
    const v = text(row?.[name]);
    if (v) return v;
  }
  return "";
}

/** 从新到旧找第一个带该字段的 row（最近一轮的身份最有解释力）。 */
function pickNewestField(rows, names) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const v = fieldOf(rows[i], names);
    if (v) return v;
  }
  return "";
}

const RUN_KEYS = ["runId", "run_id"];
const SESSION_KEYS = ["sessionId", "session_id", "session"];
const TASK_KEYS = ["taskId", "task_id", "task"];
// 审计行本身没有任务名；未来若写进来（title/runTitle），优先用行里的，查不到才查 run store。
const TITLE_KEYS = ["title", "runTitle", "taskTitle"];

const atOf = (row) => {
  const n = Number(row?.at ?? row?.ts);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 本地时区的 HH:mm（只给人看，不参与判断）。 */
function clock(ms) {
  const d = new Date(Number(ms));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 按字符数截断（中文一个字算 1），超了补省略号。 */
function clip(raw, max) {
  const chars = [...String(raw ?? "").replace(/\s+/g, " ").trim()];
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

/** 多行脚本压成一句：去掉开头的 cd，取前两行（"cd /d/x" 本身不说明在干什么）。 */
function compactCommand(raw) {
  const lines = String(raw ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  while (lines.length > 1 && /^cd\s+/i.test(lines[0])) lines.shift();
  return clip(lines.slice(0, 2).join(" ; "), 120);
}

/** 从 argsPreview 里尽量抠出"这条调用在干什么"：bash 的 command、read/write 的 path 等。 */
function commandOf(row) {
  const raw = text(row?.argsPreview);
  if (!raw) return "";
  try {
    const obj = JSON.parse(raw);
    for (const key of ["command", "cmd", "path", "file", "query"]) {
      const v = text(obj?.[key]);
      if (v) return compactCommand(v);
    }
  } catch { /* argsPreview 常被截断成不完整 JSON，走下面的正则兜底 */ }
  // argsPreview 在 240 字处截断，命令值常常没有收尾引号：这里允许 "到行尾" 结束。
  const m = raw.match(/"(?:command|cmd|path|file|query)"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/);
  if (m) {
    try { return compactCommand(JSON.parse(`"${m[1]}"`)); }
    catch { return compactCommand(m[1]); }
  }
  return "";
}

/** 失败输出摘要：优先 error（审计门 after 行会带完整失败正文），退到 resultPreview。 */
function outputOf(row) {
  return text(row?.error) || text(row?.resultPreview);
}

/** 从输出里认退出码（bash 工具会在结果末尾加「[退出码 N]」）。 */
function exitCodeOf(row) {
  const raw = `${text(row?.error)} ${text(row?.resultPreview)}`;
  const m = raw.match(/\[退出码\s*(\d+)\]/) || raw.match(/\bexit(?:\s+code)?\s*[:=]?\s*(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

/** 一条失败长什么样：命令 + 退出码/失败 + 输出片段，总长 ≤80。 */
function failureSample(row) {
  const cmd = commandOf(row);
  const exit = exitCodeOf(row);
  const out = outputOf(row).replace(/\[退出码\s*\d+\]/g, "").replace(/\s+/g, " ").trim();
  // 先截命令再包反引号：否则命令过长时收尾的反引号会被截掉，微信排版就变成裸反引号。
  const left = cmd ? `\`${clip(cmd, 36)}\`` : clip(text(row?.tool) || "一次调用", 40);
  const state = exit != null ? `退出码 ${exit}` : (row?.ok === false ? "失败" : "输出异常");
  const right = out ? `（“${clip(out, 30)}”）` : "";
  return clip(`${left} ${state}${right}`, 80);
}

/** 反复调用/只改不验的样本：这次调用在干什么。 */
function callSample(row) {
  const cmd = commandOf(row);
  return clip(cmd ? `\`${clip(cmd, 74)}\`` : `${text(row?.tool) || "?"} 调用`, 80);
}

/**
 * 给一条 issue 补上下文。所有字段都从窗口内相关 rows 取，没有就留空。
 * run 的 title 先看 rows 自带字段，再问调用方注入的 store 查询（titleOf）；
 * 查不到就是空——判断层不读盘，也不替这轮起名字。
 * @returns 原 issue + {tool, runId, sessionId, taskId, title, runIds, firstAt, lastAt, startedAt, samples, evidence}
 */
function buildIssueContext(issue, related, win, { titleOf = null } = {}) {
  const rows = (Array.isArray(related) ? related : []).filter(Boolean)
    .sort((a, b) => (atOf(a) || 0) - (atOf(b) || 0));

  // 审计门的 before 行才有 argsPreview，after 行只有 argsHash。按 argsHash 把同一次调用的
  // 命令补回来——这是窗口内真实存在的信息，不是猜的（否则失败样例只能写"bash 失败"）。
  const previewByHash = new Map();
  for (const r of win) {
    const hash = text(r?.argsHash);
    const preview = text(r?.argsPreview);
    if (hash && preview && !previewByHash.has(hash)) previewByHash.set(hash, preview);
  }
  const withArgs = rows.map((r) => {
    if (text(r?.argsPreview)) return r;
    const preview = previewByHash.get(text(r?.argsHash));
    return preview ? { ...r, argsPreview: preview } : r;
  });

  const times = withArgs.map(atOf).filter((n) => n != null);
  const firstAt = times.length ? Math.min(...times) : null;
  const lastAt = times.length ? Math.max(...times) : null;

  // 连续失败时优先拿真正失败的 rows 当身份与样例；旧判定的"输出里出现失败字样"可能
  // 是成功命令打印了含「失败」的文件名（真机见过），拿它当身份会指错轮次。
  const trueFails = withArgs.filter((r) => r?.ok === false || text(r?.error));
  const pool = issue.code === "failing" && trueFails.length ? trueFails : withArgs;

  const runId = pickNewestField(pool, RUN_KEYS) || pickNewestField(withArgs, RUN_KEYS);
  const sessionId = pickNewestField(pool, SESSION_KEYS) || pickNewestField(withArgs, SESSION_KEYS);
  const taskId = pickNewestField(pool, TASK_KEYS) || pickNewestField(withArgs, TASK_KEYS);

  // 任务名：行里有就用（未来审计门若写入 title），否则问注入的 run store。
  // 没有 runId / 查不到 / 查询抛错 → 留空（通知与 watchdog_read 会明说「这轮没带名字」）。
  let title = pickNewestField(pool, TITLE_KEYS) || pickNewestField(withArgs, TITLE_KEYS);
  if (!title && runId && typeof titleOf === "function") {
    try { title = text(titleOf(runId)); } catch { title = ""; }
  }

  // 涉及到的轮次（新的在前，最多 5 个）：一条 issue 可能横跨两轮，通知里要能说"另有 N 轮"。
  const runIds = [];
  for (let i = withArgs.length - 1; i >= 0; i -= 1) {
    const v = fieldOf(withArgs[i], RUN_KEYS);
    if (v && !runIds.includes(v)) runIds.push(v);
    if (runIds.length >= 5) break;
  }

  // "22:12 开始"指这一轮真正开始的时间，而不是问题第一次出现的时间；取窗口内同 run 的最早一条。
  let startedAt = firstAt;
  if (runId) {
    const runTimes = win.filter((r) => fieldOf(r, RUN_KEYS) === runId).map(atOf).filter((n) => n != null);
    if (runTimes.length) startedAt = Math.min(...runTimes);
  } else if (sessionId) {
    const sessTimes = win.filter((r) => fieldOf(r, SESSION_KEYS) === sessionId).map(atOf).filter((n) => n != null);
    if (sessTimes.length) startedAt = Math.min(...sessTimes);
  }

  const evidence = runId ? `run:${runId}`
    : sessionId ? `session:${sessionId}`
      : taskId ? `task:${taskId}`
        : firstAt ? `time:${clock(firstAt)}-${clock(lastAt || firstAt)}`
          : "none";

  const newest = pool.slice(-2).reverse();
  let samples = [];
  if (issue.code === "failing") samples = newest.map(failureSample);
  else if (issue.code === "loop") samples = withArgs.slice(-2).reverse().map(callSample);
  else if (issue.code === "no_gate") samples = withArgs.slice(-2).reverse().map(callSample);
  else samples = newest.map(callSample);
  samples = samples.filter(Boolean).map((s) => clip(s, 80));

  return {
    ...issue,
    tool: text(issue.tool) || text(withArgs[withArgs.length - 1]?.tool),
    runId,
    sessionId,
    taskId,
    title: clip(title, 40),
    runIds,
    firstAt,
    lastAt,
    startedAt,
    samples,
    evidence,
  };
}

export function detectDrift(rows = [], { now = Date.now(), windowMs = 30 * 60 * 1000, repeatLimit = 5, failLimit = 3, titleOf = null } = {}) {
  const since = now - windowMs;
  const win = (Array.isArray(rows) ? rows : []).filter((r) => {
    const t = Number(r?.at || r?.ts || 0);
    return Number.isFinite(t) && t >= since;
  });
  const issues = [];
  const isFailure = (r) => r?.ok === false || /error|失败|denied/i.test(String(r?.resultPreview || ""));

  // ① 空转：同一个工具 + 同一组参数反复调用
  const byKey = new Map();
  for (const r of win) {
    const k = `${r.tool || "?"}|${r.argsHash || ""}`;
    byKey.set(k, (byKey.get(k) || 0) + 1);
  }
  for (const [k, n] of byKey) {
    if (n >= repeatLimit) {
      const tool = k.split("|")[0];
      issues.push(buildIssueContext(
        { code: "loop", detail: `${tool} 同参数重复 ${n} 次`, n, tool },
        win.filter((r) => `${r.tool || "?"}|${r.argsHash || ""}` === k),
        win,
        { titleOf },
      ));
    }
  }

  // ② 连续失败：同一工具反复报错
  const fails = new Map();
  for (const r of win) {
    if (isFailure(r)) fails.set(r.tool || "?", (fails.get(r.tool || "?") || 0) + 1);
  }
  for (const [tool, n] of fails) {
    if (n >= failLimit) {
      issues.push(buildIssueContext(
        { code: "failing", detail: `${tool} 连续失败 ${n} 次`, n, tool },
        win.filter((r) => (r.tool || "?") === tool && isFailure(r)),
        win,
        { titleOf },
      ));
    }
  }

  // ③ 只动不改：写了一堆文件却没有一次交付判定（可能在做无用功）
  const writeRows = win.filter((r) => ["write", "edit"].includes(String(r.tool || "")));
  const writes = writeRows.length;
  const gates = win.filter((r) => String(r.tool || "") === "delivery_check").length;
  if (writes >= 6 && gates === 0) {
    issues.push(buildIssueContext(
      { code: "no_gate", detail: `改了 ${writes} 次却没过一次交付门`, n: writes, tool: "write" },
      writeRows,
      win,
      { titleOf },
    ));
  }

  return { drift: issues.length > 0, issues, stats: { calls: win.length, writes, gates, windowMin: Math.round(windowMs / 60000) } };
}

/** 落台账（一行一次判定，便于回看"什么时候开始偏"）。 */
export function recordDriftCheck(wsRoot, result, { now = Date.now() } = {}) {
  try {
    const dir = path.join(String(wsRoot || "."), "记忆", "运行时");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "看门狗.jsonl"), JSON.stringify({ at: now, ...result }) + "\n", "utf8");
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}

/** 最近的判定（给界面/接口用）。 */
export function recentDrift(wsRoot, limit = 20) {
  try {
    const file = path.join(String(wsRoot || "."), "记忆", "运行时", "看门狗.jsonl");
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean).slice(-limit).reverse();
  } catch { return [] }
}
