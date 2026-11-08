// ===== claim-verify.mjs —— 断言闸门（verify-gate，2026-11-09）=====
//
// 来源：曦（xinyu-hermes）的 skills/verify-gate —— 说「我查过了 / 一共 92 项 / 文件在里面 /
// 测试全过」之前，先把结论拆成**原子断言**，逐条比对原始事实，全绿才放行。
//
// 为什么要有它：元枢已经有交付门（delivery-gate）管「改动有没有验证覆盖」，
// 但管不到**话里的数字和事实**——没查就说查了、没数就报 92 项，这是最贵的一类幻觉：
// 一个数字错了，后面所有判断都建在沙上。所以闸门必须能落到"字节数/行数/存在性"这种硬事实上。
//
// 纪律（硬约束，测试盯着）：
//   · 纯逻辑 + 注入执行器：所有外部命令走注入的 run(cmd, opts)；默认实现 execFile（不经 shell 拼串）
//   · 命令执行前必须过 engine/tools/security.mjs 的 matchDenyRule / DANGEROUS_CMD_RE
//   · 路径参数必须落在允许根内（safeJoin + 绝对路径前缀校验 + symlink 复核）
//   · 不做任何形式的任意 JS 求值（没有 eval / new Function / vm）
//
// 八种断言，返回结构统一 {type, target, expected, actual, ok, detail}：
//   EXISTS(path)                     文件/目录在不在
//   NOT_EXISTS(path)                 文件/目录确实不在
//   COUNT(<命令输出行数 | 匹配数 | 条目数>, op, expected)
//   CONTAINS(<文本 | 命令输出>, needle)
//   LINE_EQ(<文本 | 命令输出>, line, expected)          第 N 行是否等于
//   LINE_INCLUDES(<文本 | 命令输出>, line, expected)    第 N 行是否包含
//   SIZE_GT(path, bytes)             字节数是否大于
//   SIZE_EQ(path, bytes)             字节数是否等于
// 汇总：{ok, passed, failed, total, results[]}
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { matchDenyRule, DANGEROUS_CMD_RE, normalizeToolPath, safeJoin } from "./tools/security.mjs";
import { isSensitivePath, commandTouchesSensitive } from "./tools/secrets-guard.mjs";
import { withUtf8CodePage, decodeWindowsOutput } from "./windows-shell.mjs";

export const ASSERTION_TYPES = [
  "EXISTS", "NOT_EXISTS", "COUNT", "CONTAINS", "LINE_EQ", "LINE_INCLUDES", "SIZE_GT", "SIZE_EQ",
];

// 一次最多 8 条：闸门是「开口前先核一遍」，不是把整份测试报告塞进来重跑。
export const MAX_CLAIMS = 8;

export const COUNT_OPS = ["==", "!=", ">", ">=", "<", "<="];

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_BUFFER = 4 * 1024 * 1024;
// 单文件最多读 2MB：比这大的东西不该用「读全文再数」的方式验证。
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const WIN = process.platform === "win32";
const resolveAbs = (p) => path.resolve(String(p || ""));

/** 比较用的路径规范形：Windows 不分大小写，统一小写便于前缀判定。 */
function normPath(p) {
  const abs = resolveAbs(p);
  return WIN ? abs.toLowerCase() : abs;
}

/** abs 是否落在 root 内（含 root 自身）。 */
export function isInsideRoot(root, abs) {
  const r = normPath(root);
  const a = normPath(abs);
  if (!r) return false;
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * 命令红线：命中宪法 deny 规则或危险命令 → 拒绝执行。
 * 默认执行器与 runClaims 各过一遍：注入的 run 也不能绕过这条。
 */
export function assertCommandAllowed(command) {
  const line = String(command ?? "").trim();
  if (!line) return { ok: false, rule: "empty", error: "空命令：命令类断言必须给 command" };
  // 凭据防护（与 bash 工具同一层）：命令引用 auth.json/.env/.token 这类文件不执行——
  // 断言只该核「多少行/有没有这段字」，不该把密钥读出来数。
  if (commandTouchesSensitive(line)) return { ok: false, rule: "secrets", error: "命令引用凭据文件，不执行（断言不碰密钥）" };
  const hit = matchDenyRule(line);
  if (hit) return { ok: false, rule: hit.id, error: `命令命中安全红线 ${hit.id}` };
  if (DANGEROUS_CMD_RE.test(line)) return { ok: false, rule: "dangerous-cmd", error: "命令命中危险命令拦截（可能造成不可逆数据丢失）" };
  return { ok: true };
}

/**
 * 默认执行器：execFile（命令行整体交给 shell 一次，不做字符串拼脚本、不做求值）。
 * 执行前先过安全红线；命中直接返回 denied，不去起进程。
 */
export function defaultRun(command, { cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const guard = assertCommandAllowed(command);
  if (!guard.ok) {
    return Promise.resolve({ ok: false, code: -1, stdout: "", stderr: guard.error, denied: true, rule: guard.rule });
  }
  const exe = WIN ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const body = WIN ? withUtf8CodePage(String(command), { platform: "win32", shell: null }) : String(command);
  const args = WIN ? ["/c", body] : ["-c", String(command)];
  return new Promise((resolve) => {
    try {
      execFile(exe, args, {
        cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_BUFFER, encoding: "buffer",
      }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          stdout: decodeWindowsOutput(stdout),
          stderr: decodeWindowsOutput(stderr),
          error: err ? String(err?.message || err).slice(0, 200) : "",
        });
      });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: "", stderr: "", error: String(e?.message || e).slice(0, 200) });
    }
  });
}

/**
 * 路径 → 允许根内的绝对路径。
 *  · 相对路径：按 roots 顺序 safeJoin，优先取已存在的那个（工作区在第一个根）
 *  · 绝对路径：必须命中某个根的前缀，再过一遍 safeJoin（symlink 复核）
 *  · 越界一律 null，由调用方判失败——不静默改成根内路径
 */
export function resolveClaimPath(raw, { roots = [] } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "路径为空" };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: "路径含控制字符" };
  // 凭据防护：auth.json/.env/.token 这类文件不参与断言——CONTAINS 能把密钥猜出来。
  if (isSensitivePath(text)) return { ok: false, error: `凭据文件不参与断言：${text}` };
  const list = (Array.isArray(roots) ? roots : []).map((r) => String(r || "")).filter(Boolean).map(resolveAbs);
  if (!list.length) return { ok: false, error: "没有可用的允许根（roots 未配置）" };
  const wanted = normalizeToolPath(text);
  if (path.isAbsolute(wanted)) {
    const root = list.find((r) => isInsideRoot(r, wanted));
    if (!root) return { ok: false, error: `路径越界：${text}（只允许 ${list.join(" / ")} 之内）` };
    const guarded = safeJoin(root, wanted);
    if (!guarded) return { ok: false, error: `路径越界：${text}（解析后跑出了允许根，可能是符号链接）` };
    if (isSensitivePath(guarded)) return { ok: false, error: `凭据文件不参与断言：${text}` };
    return { ok: true, path: guarded, root };
  }
  let fallback = null;
  for (const root of list) {
    const guarded = safeJoin(root, wanted);
    if (!guarded) continue;
    if (isSensitivePath(guarded)) return { ok: false, error: `凭据文件不参与断言：${text}` };
    fallback = fallback || { ok: true, path: guarded, root };
    try { if (fs.existsSync(guarded)) return { ok: true, path: guarded, root }; } catch { /* 读不到就当没命中 */ }
  }
  if (fallback) return fallback;
  return { ok: false, error: `路径越界：${text}（只允许 ${list.join(" / ")} 之内）` };
}

function readTextFile(file) {
  const st = fs.statSync(file);
  if (st.isDirectory()) return { ok: false, error: "这是目录，不是文件" };
  if (st.size > MAX_TEXT_BYTES) return { ok: false, error: `文件太大（${st.size}B），不适合读全文比对` };
  return { ok: true, text: fs.readFileSync(file, "utf8") };
}

/** 行数：按实际行数数（末尾换行不算多一行）；空输出记 0。 */
function countLines(text) {
  const body = String(text ?? "").replace(/\s+$/, "");
  if (!body) return 0;
  return body.split(/\r?\n/).length;
}

/** 匹配数：整个文本里 needle 出现了几次（非重叠）。 */
function countMatches(text, needle) {
  const t = String(text ?? "");
  const n = String(needle ?? "");
  if (!n) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = t.indexOf(n, from);
    if (at === -1) return count;
    count++;
    from = at + n.length;
  }
}

function compare(actual, op, expected) {
  switch (String(op || "==")) {
    case "==": return actual === expected;
    case "!=": return actual !== expected;
    case ">": return actual > expected;
    case ">=": return actual >= expected;
    case "<": return actual < expected;
    case "<=": return actual <= expected;
    default: return null;
  }
}

function asNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  const s = String(v ?? "").trim().replace(/[,_\s]/g, "");
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function labelOf(claim) {
  const target = String(claim?.target ?? "").trim();
  if (target) return target;
  const command = String(claim?.command ?? "").trim();
  return command ? `cmd: ${command.length > 60 ? command.slice(0, 60) + "…" : command}` : "（未给目标）";
}

/** 给了 command 字段就走命令（哪怕是空串——那也要报「空命令」，而不是悄悄当成查文件）。 */
function commandOf(claim) {
  const raw = claim?.command;
  if (raw === undefined || raw === null) return null;
  return String(raw);
}

/**
 * 取断言的「事实来源」：命令输出优先，否则读文件。
 *  · text    = 两路输出都在（CONTAINS 用：出错信息里也可能有要找的字）
 *  · primary = stdout，为空时用 stderr（行数/行号按它算，才跟模型看到的一致）
 */
async function sourceText(claim, ctx) {
  const command = commandOf(claim);
  if (command !== null) {
    const guard = assertCommandAllowed(command);
    if (!guard.ok) return { ok: false, blocked: true, error: guard.error, rule: guard.rule };
    let out;
    try {
      out = await ctx.run(command, { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs });
    } catch (e) {
      return { ok: false, error: `命令执行失败：${String(e?.message || e).slice(0, 160)}` };
    }
    if (!out || typeof out !== "object") return { ok: false, error: "执行器没有返回结果" };
    if (out.denied) return { ok: false, blocked: true, error: String(out.stderr || "命令被拒绝执行"), rule: out.rule };
    const stdout = String(out.stdout ?? "");
    const stderr = String(out.stderr ?? "");
    return {
      ok: true,
      text: [stdout, stderr].filter(Boolean).join("\n"),
      primary: stdout.trim() ? stdout : stderr,
      exitCode: out.code,
      commandOk: !!out.ok,
    };
  }
  const target = String(claim?.target ?? "").trim();
  if (!target) return { ok: false, error: "缺少 target 或 command" };
  const resolved = resolveClaimPath(target, { roots: ctx.roots });
  if (!resolved.ok) return { ok: false, blocked: true, error: resolved.error };
  try {
    const read = readTextFile(resolved.path);
    if (!read.ok) return { ok: false, error: `${target}：${read.error}` };
    return { ok: true, text: read.text, primary: read.text, path: resolved.path };
  } catch (e) {
    return { ok: false, error: `${target}：读不到（${String(e?.message || e).slice(0, 120)}）` };
  }
}

function baseResult(claim, type, extra = {}) {
  return { type, target: labelOf(claim), expected: claim?.expected ?? null, actual: null, ok: false, detail: "", ...extra };
}

async function evalExists(claim, ctx, shouldExist) {
  const type = shouldExist ? "EXISTS" : "NOT_EXISTS";
  const target = String(claim?.target ?? "").trim();
  const resolved = resolveClaimPath(target, { roots: ctx.roots });
  if (!resolved.ok) return baseResult(claim, type, { expected: shouldExist ? "存在" : "不存在", actual: "无法判定", detail: resolved.error });
  let exists = false;
  try { exists = fs.existsSync(resolved.path); } catch { exists = false; }
  const actual = exists ? "存在" : "不存在";
  const ok = shouldExist ? exists : !exists;
  return baseResult(claim, type, {
    expected: shouldExist ? "存在" : "不存在",
    actual,
    ok,
    detail: ok ? `${target} ${actual}` : `${target} ${actual}（期望${shouldExist ? "存在" : "不存在"}）`,
    path: resolved.path,
  });
}

async function evalCount(claim, ctx) {
  const op = String(claim?.op || "==");
  const expected = asNumber(claim?.expected);
  const res = baseResult(claim, "COUNT", { expected: Number.isNaN(expected) ? (claim?.expected ?? null) : expected });
  if (Number.isNaN(expected)) return { ...res, detail: "expected 不是数字（例：{\"kind\":\"COUNT\",\"target\":\"生成物/图片\",\"op\":\"==\",\"expected\":92}）" };
  if (!COUNT_OPS.includes(op)) return { ...res, detail: `未知操作符「${op}」（可用 ${COUNT_OPS.join(" ")}）` };
  const command = commandOf(claim);
  const match = String(claim?.match ?? "");
  if (command !== null) {
    const src = await sourceText(claim, ctx);
    if (!src.ok) return { ...res, detail: src.error };
    const actual = match ? countMatches(src.text, match) : countLines(src.primary);
    const noun = match ? "匹配数" : "行数";
    return { ...res, expected, actual, noun, ok: compare(actual, op, expected) === true, detail: `${noun}：${actual} ${op} ${expected}` };
  }
  const target = String(claim?.target ?? "").trim();
  const resolved = resolveClaimPath(target, { roots: ctx.roots });
  if (!resolved.ok) return { ...res, actual: "无法判定", detail: resolved.error };
  let stat;
  try { stat = fs.statSync(resolved.path); } catch { return { ...res, actual: 0, detail: `${target}：不存在` }; }
  if (stat.isDirectory()) {
    let names;
    try { names = fs.readdirSync(resolved.path); } catch (e) { return { ...res, detail: `${target}：读不到目录（${String(e?.message || e).slice(0, 100)}）` }; }
    const filtered = match ? names.filter((n) => n.toLowerCase().includes(match.toLowerCase())) : names;
    const actual = filtered.length;
    const noun = match ? "匹配数" : "条目数";
    return { ...res, expected, actual, noun, ok: compare(actual, op, expected) === true, detail: `${noun}：${actual} ${op} ${expected}` };
  }
  if (match) {
    const read = readTextFile(resolved.path);
    if (!read.ok) return { ...res, detail: `${target}：${read.error}` };
    const actual = countMatches(read.text, match);
    return { ...res, expected, actual, noun: "匹配数", ok: compare(actual, op, expected) === true, detail: `匹配数：${actual} ${op} ${expected}` };
  }
  const read = readTextFile(resolved.path);
  if (!read.ok) return { ...res, detail: `${target}：${read.error}` };
  const actual = countLines(read.text);
  return { ...res, expected, actual, noun: "行数", ok: compare(actual, op, expected) === true, detail: `行数：${actual} ${op} ${expected}` };
}

async function evalContains(claim, ctx) {
  const needle = String(claim?.expected ?? "");
  const res = baseResult(claim, "CONTAINS", { expected: `含「${needle}」` });
  if (!needle) return { ...res, detail: "CONTAINS 需要 expected（要找的那段文字）" };
  const src = await sourceText(claim, ctx);
  if (!src.ok) return { ...res, actual: "无法判定", detail: src.error };
  const found = src.text.includes(needle);
  return { ...res, actual: found ? "含" : "未找到", ok: found, detail: found ? `找到「${needle}」` : `未找到「${needle}」` };
}

async function evalLine(claim, ctx, includes) {
  const type = includes ? "LINE_INCLUDES" : "LINE_EQ";
  const needle = String(claim?.expected ?? "");
  const lineNo = asNumber(claim?.line ?? claim?.lineNo);
  const res = baseResult(claim, type, { expected: includes ? `含「${needle}」` : `"${needle}"`, line: Number.isFinite(lineNo) ? lineNo : null });
  if (!Number.isFinite(lineNo) || lineNo < 1) return { ...res, detail: "需要 line（第几行，从 1 开始）" };
  const src = await sourceText(claim, ctx);
  if (!src.ok) return { ...res, actual: "无法判定", detail: src.error };
  const lines = String(src.primary).split(/\r?\n/);
  if (lineNo > lines.length) return { ...res, actual: `（只有 ${lines.length} 行）`, detail: `第 ${lineNo} 行不存在（共 ${lines.length} 行）` };
  const actual = lines[lineNo - 1].trim();
  const ok = includes ? actual.includes(needle) : actual === needle.trim();
  const res2 = { ...res, actual };
  if (!ok) return { ...res2, detail: includes ? `第 ${lineNo} 行不含「${needle}」：「${actual.slice(0, 120)}」` : `第 ${lineNo} 行是「${actual.slice(0, 120)}」，不是「${needle}」` };
  return { ...res2, ok: true, detail: `第 ${lineNo} 行${includes ? "含" : "是"}「${actual.slice(0, 120)}」` };
}

async function evalSize(claim, ctx, greater) {
  const type = greater ? "SIZE_GT" : "SIZE_EQ";
  const expected = asNumber(claim?.expected);
  const target = String(claim?.target ?? "").trim();
  const res = baseResult(claim, type, { expected: Number.isNaN(expected) ? (claim?.expected ?? null) : expected });
  if (Number.isNaN(expected)) return { ...res, detail: "expected 不是数字（字节数，例：1024）" };
  const resolved = resolveClaimPath(target, { roots: ctx.roots });
  if (!resolved.ok) return { ...res, actual: "无法判定", detail: resolved.error };
  let st;
  try { st = fs.statSync(resolved.path); } catch { return { ...res, actual: "不存在", detail: `${target}：不存在` }; }
  if (st.isDirectory()) return { ...res, actual: "目录", detail: `${target}：这是目录，不是文件` };
  const actual = st.size;
  const ok = greater ? actual > expected : actual === expected;
  return { ...res, actual, ok, detail: greater ? `${actual}B > ${expected}B` : `${actual}B == ${expected}B` };
}

/** 跑一条断言：任何异常都收敛成 FAIL，不把异常往上抛（闸门自己不能崩）。 */
async function evalClaim(claim, ctx) {
  const kind = String(claim?.kind ?? "").trim().toUpperCase();
  if (!ASSERTION_TYPES.includes(kind)) {
    return baseResult(claim, kind || "UNKNOWN", { detail: `未知断言「${claim?.kind ?? ""}」（可用 ${ASSERTION_TYPES.join(" / ")}）` });
  }
  if (kind === "EXISTS") return evalExists(claim, ctx, true);
  if (kind === "NOT_EXISTS") return evalExists(claim, ctx, false);
  if (kind === "COUNT") return evalCount(claim, ctx);
  if (kind === "CONTAINS") return evalContains(claim, ctx);
  if (kind === "LINE_EQ") return evalLine(claim, ctx, false);
  if (kind === "LINE_INCLUDES") return evalLine(claim, ctx, true);
  if (kind === "SIZE_GT") return evalSize(claim, ctx, true);
  return evalSize(claim, ctx, false);
}

/**
 * 跑一组断言，返回汇总。
 * @param {Array} claims 断言数组（最多 MAX_CLAIMS 条）
 * @param {object} opts {roots, run, cwd, timeoutMs, maxClaims, now}
 * @returns {{ok:boolean, passed:number, failed:number, total:number, results:object[], error?:string, rejected?:boolean}}
 */
export async function runClaims(claims, opts = {}) {
  const list = Array.isArray(claims) ? claims : [];
  const maxClaims = Number.isFinite(opts.maxClaims) ? opts.maxClaims : MAX_CLAIMS;
  const roots = (Array.isArray(opts.roots) ? opts.roots : []).filter(Boolean);
  if (!list.length) {
    return { ok: false, passed: 0, failed: 0, total: 0, results: [], rejected: true, error: "没有断言：verify_check 至少要一条（空调用证明不了任何事）" };
  }
  if (list.length > maxClaims) {
    return {
      ok: false, passed: 0, failed: list.length, total: list.length, results: [], rejected: true,
      error: `断言太多（${list.length} 条，上限 ${maxClaims} 条）：拆成两三次调用，或只留最关键的几条`,
    };
  }
  const ctx = {
    roots,
    run: typeof opts.run === "function" ? opts.run : defaultRun,
    cwd: opts.cwd || roots[0] || process.cwd(),
    timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
  const results = [];
  for (const claim of list) {
    try {
      results.push(await evalClaim(claim, ctx));
    } catch (e) {
      results.push(baseResult(claim, String(claim?.kind ?? "UNKNOWN").toUpperCase(), { detail: `断言异常：${String(e?.message || e).slice(0, 160)}` }));
    }
  }
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  return { ok: failed === 0, passed, failed, total: results.length, results };
}

// ── 人能读的渲染（只回给模型；闸门本身不往聊天里推送）──

function short(s, n = 80) {
  const text = String(s ?? "");
  return text.length > n ? text.slice(0, n) + "…" : text;
}

/** 一条断言 → 一行。通过只写事实，未过写「预期 X 实际 Y」。 */
export function formatClaimLine(r) {
  if (!r || typeof r !== "object") return "❌ 无法解析的断言";
  const icon = r.ok ? "✅" : "❌";
  const type = String(r.type || "UNKNOWN");
  const target = short(r.target, 100);
  const head = `${icon} ${type} ${target}`;
  const noun = r.noun || "数量";
  if (r.ok) {
    if (type === "COUNT") return `${head} ${noun} ${r.actual}`;
    if (type === "SIZE_GT") return `${head} ${r.actual}B > ${r.expected}B`;
    if (type === "SIZE_EQ") return `${head} ${r.actual}B`;
    if (type === "LINE_EQ" || type === "LINE_INCLUDES") return `${head} ${short(r.actual, 60)}`;
    return head;
  }
  const expected = r.expected === null || r.expected === undefined ? "（未给）" : r.expected;
  const actual = r.actual === null || r.actual === undefined ? "（未取到）" : r.actual;
  // 判不了（越界/红线/参数不对）时，原因比「实际」有用得多——否则模型只会原样重试。
  if ((r.actual === null || r.actual === undefined || r.actual === "无法判定") && r.detail) {
    return `${head} 无法判定：${short(r.detail, 120)}`;
  }
  if (type === "COUNT") return `${head} ${noun} 预期 ${short(expected, 60)} 实际 ${short(actual, 60)}`;
  return `${head} 预期 ${short(expected, 60)} 实际 ${short(actual, 60)}`;
}

/** 汇总 → 多行文本（首行计数，末行给「别报完成」的下一步）。 */
export function formatClaimReport(summary) {
  const s = summary || {};
  if (s.error) return `⛔ 断言闸门没有跑：${s.error}`;
  const lines = [`断言闸门：${s.total} 条 · 通过 ${s.passed} · 未过 ${s.failed}`];
  for (const r of Array.isArray(s.results) ? s.results : []) lines.push(formatClaimLine(r));
  if (s.failed > 0) {
    const bad = (s.results || []).filter((r) => !r.ok);
    lines.push("");
    lines.push(`有一条没过就别说完成：把上面的实际数字说出来，或如实说「没查到」。${bad.length ? `未过的是 ${bad.map((r) => r.type).join(" / ")}。` : ""}`);
  }
  if (s.passed > 0 && s.failed === 0) lines.push("全部通过——可以按这些数字开口，但不许再加没验过的数字。");
  return lines.join("\n");
}
