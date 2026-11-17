// 执行员子代理的工具箱（2026-11-18）：研究员的只读四件 + write / edit / bash。
//
// 为什么单开：研究员只能查不能动手，主代理派出去的活最后还得自己落地。执行员能落地，
// 但每一步有副作用的调用都要先过伙伴：子代理停下 → 主聊天弹卡（批准这一步 / 这一轮都批准 / 拒绝）
// → 伙伴点了再接着干（断点续跑那套，停着等的时候重启也不丢）。
// 护栏与主聊天同一套：凭据文件不可见不可写、受保护路径（人格定义等）只读、危险命令与红线规则直接拒，
// 这些拒绝不需要伙伴拍板——批准也放不开。
import fs from "node:fs";
import path from "node:path";
import { RESEARCH_TOOLS, resolveInRoots } from "./subagent-research.mjs";
import { commandTouchesSensitive, redactSecrets } from "./tools/secrets-guard.mjs";
import { isProtectedPath, DANGEROUS_CMD_RE, matchDenyRule } from "./tools/security.mjs";
import { detectBashShell } from "./tools/unified-tools.mjs";
import { execFileAbortable } from "./yuanshu-stability.mjs";

export const WORKER_MAX_STEPS = 16;
const MAX_OUTPUT = 8000;
const MAX_WRITE_BYTES = 512 * 1024;
const BASH_TIMEOUT_MS = 120_000;

const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
export const WORKER_ACT_TOOLS = Object.freeze([
  fn("write", "新建或整体覆盖一个文本文件（工作区内）。中文内容一律用它写，别用 echo。需要伙伴批准。", {
    path: { type: "string" }, content: { type: "string" },
  }, ["path", "content"]),
  fn("edit", "精确替换文件里的一段文本：old 必须在文件里恰好出现一次。需要伙伴批准。", {
    path: { type: "string" }, old: { type: "string", description: "要替换的原文（含缩进，必须唯一）" }, new: { type: "string" },
  }, ["path", "old", "new"]),
  fn("bash", "在工作区根目录跑一条命令（2 分钟超时），返回输出与退出码。需要伙伴批准。", {
    command: { type: "string" },
  }, ["command"]),
]);
export const WORKER_TOOLS = Object.freeze([...RESEARCH_TOOLS, ...WORKER_ACT_TOOLS]);
export const WORKER_TOOL_NAMES = WORKER_TOOLS.map(t => t.function.name);
const ACT_NAMES = new Set(WORKER_ACT_TOOLS.map(t => t.function.name));

export const isActCall = (tc) => ACT_NAMES.has(String(tc?.function?.name || ""));

const parseArgs = (tc) => { try { return JSON.parse(tc?.function?.arguments || "{}") || {}; } catch { return {}; } };
const clipLine = (s, max) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** 卡片上的一行：让伙伴一眼看清要干什么。 */
export function describeAct(tc) {
  const a = parseArgs(tc);
  const name = tc?.function?.name;
  if (name === "write") return `写文件 ${clipLine(a.path, 80)}（${String(a.content ?? "").length} 字）`;
  if (name === "edit") return `改文件 ${clipLine(a.path, 80)}：「${clipLine(a.old, 30)}」→「${clipLine(a.new, 30)}」`;
  if (name === "bash") return `跑命令 ${clipLine(a.command, 120)}`;
  return clipLine(name, 40);
}

export const APPROVAL_OPTIONS = Object.freeze(["批准这一步", "这一轮都批准", "拒绝"]);

/** 一轮里有副作用的调用 → 审批卡（choice 卡片的 question/options）。 */
export function approvalCard(toolCalls = []) {
  const acts = toolCalls.filter(isActCall).map(describeAct);
  const head = acts.length > 1 ? `子代理要做 ${acts.length} 件有副作用的事：` : "子代理要";
  return { kind: "approval", question: clipLine(`${head}${acts.join("；")}`, 300), options: [...APPROVAL_OPTIONS] };
}

/**
 * 卡片点回来的话是 `关于「问题」：我选「选项」`（frontend/src/lib/choice-reply.mjs）——
 * 问题里带着命令原文（可能有 --no-verify、"取消"之类），只看伙伴自己说的那部分。
 */
export function approvalReply(text) {
  const s = String(text || "").trim();
  const picked = s.match(/我选「([^「」]+)」\s*$/);
  if (picked) return { answer: picked[1], note: "" };
  const at = s.startsWith("关于「") ? s.indexOf("」：") : -1;
  const answer = at >= 0 ? s.slice(at + 2).trim() : s;
  return { answer, note: APPROVAL_OPTIONS.includes(answer) ? "" : answer };
}

/** 伙伴的回话 → once / all / reject。听不懂的一律按拒绝处理（宁可多问一次，不替人点头）。 */
export function parseApproval(text) {
  const s = approvalReply(text).answer;
  if (!s) return "reject";
  if (/拒绝|不行|不要|别|不批|取消|no\b|reject/i.test(s)) return "reject";
  if (/都批准|全部批准|全批|这一轮都|以后都|approve all/i.test(s)) return "all";
  if (/批准|同意|可以|行|好|ok|yes|approve|继续/i.test(s)) return "once";
  return "reject";
}

const fail = (text) => ({ text, isError: true });
const clipOut = (text) => {
  const s = redactSecrets(String(text ?? ""));
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（输出超过 ${MAX_OUTPUT} 字符已截断）` : s;
};

/** 不论批没批都不许做的（批准也放不开）；返回拒绝原因或 ""。 */
export function hardBlock(tc, roots = []) {
  const name = tc?.function?.name;
  const a = parseArgs(tc);
  if (name === "write" || name === "edit") {
    const p = resolveInRoots(roots, a.path);
    if (!p) return `不可写：${a.path}（只能写工作区内的非凭据文件）`;
    if (isProtectedPath(p)) return `受保护文件只读：${a.path}`;
    return "";
  }
  if (name === "bash") {
    const cmd = String(a.command || "");
    if (!cmd.trim()) return "bash 需要 command";
    if (commandTouchesSensitive(cmd)) return "命令引用了凭据文件，子代理不能碰";
    if (DANGEROUS_CMD_RE.test(cmd)) return "危险命令（删除/格式化/强杀等）子代理不能跑，交给主代理或伙伴";
    const rule = matchDenyRule(cmd, { notify: true, source: "subagent" });
    if (rule) return `命中红线规则 ${rule.id}，不能执行`;
    return "";
  }
  return "";
}

export function createWorkerExecutor({ roots = [], research = null } = {}) {
  const list = () => [...new Set((typeof roots === "function" ? roots() : roots) || [])].filter(Boolean);
  return async function executeWorkerTool(name, args = {}, { signal } = {}) {
    if (!ACT_NAMES.has(name)) return research ? research(name, args) : fail(`没有这个工具：${name}`);
    const usable = list();
    const blocked = hardBlock({ function: { name, arguments: JSON.stringify(args) } }, usable);
    if (blocked) return fail(blocked);
    try {
      if (name === "write") {
        const p = resolveInRoots(usable, args.path);
        const content = String(args.content ?? "");
        if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return fail(`内容超过 ${MAX_WRITE_BYTES / 1024}KB，拆成几个文件写`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const existed = fs.existsSync(p);
        fs.writeFileSync(p, content, "utf8");
        return { text: `${existed ? "已覆盖" : "已新建"} ${p}（${content.length} 字）` };
      }
      if (name === "edit") {
        const p = resolveInRoots(usable, args.path);
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return fail(`文件不存在：${args.path}`);
        const raw = fs.readFileSync(p, "utf8");
        // CRLF 文件：模型给的 old 多半是 LF，统一成 LF 匹配，写回时还原
        const crlf = raw.includes("\r\n");
        const text = crlf ? raw.replace(/\r\n/g, "\n") : raw;
        const oldText = String(args.old ?? "").replace(/\r\n/g, "\n");
        if (!oldText) return fail("edit 需要 old");
        const count = text.split(oldText).length - 1;
        if (count !== 1) return fail(count ? `old 在文件里出现了 ${count} 次，多带几行上下文让它唯一` : "old 在文件里找不到（注意缩进与原文一字不差）");
        const next = text.replace(oldText, () => String(args.new ?? "").replace(/\r\n/g, "\n"));
        fs.writeFileSync(p, crlf ? next.replace(/\n/g, "\r\n") : next, "utf8");
        return { text: `已改 ${p}` };
      }
      const cwd = path.resolve(usable[0] || process.cwd());
      const shell = detectBashShell();
      const cmd = String(args.command);
      const opts = { cwd, timeout: BASH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal };
      const { stdout, stderr, exitCode } = shell
        ? await execFileAbortable(shell, ["-lc", cmd], opts)
        : await execFileAbortable(process.env.ComSpec || "cmd.exe", ["/c", `chcp 65001>nul & ${cmd}`], opts);
      const out = [String(stdout || "").trim(), String(stderr || "").trim() ? `[stderr]\n${String(stderr).trim()}` : ""].filter(Boolean).join("\n");
      return { text: clipOut(`退出码 ${exitCode}\n${out || "（无输出）"}`), isError: exitCode !== 0 };
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      return fail(`工具执行失败：${String(e?.message || e).slice(0, 300)}`);
    }
  };
}
