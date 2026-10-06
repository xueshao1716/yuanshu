// ===== security.mjs —— 工具层安全原语（从 server.mjs 抽离，纯函数无状态）=====
// 三层防线：User 层 deny 规则（宪法红线）→ 危险/交互命令拦截 → 受保护路径只读。
// 任何 allow 都不能覆盖 deny；命中即拒绝并给出规则 id 方便排查。

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ── User 层 deny 规则（宪法硬性红线 → 代码硬拦截，deny 永远赢）──
// 来源：宪法.json 条款（no-tunnel / no-secrets / no-engine-edit 等）
export const USER_DENY_PATTERNS = [
  { id: "no-tunnel", re: /\b(cloudflared|ngrok|frpc|frps|localtunnel|bore|nps)\b/i },
  { id: "no-tunnel-ssh", re: /\bssh\b[^\n]*\s(-R|-L|-D)\b/ },
  { id: "no-tunnel-socat", re: /\bsocat\b[^\n]*(tcp-listen|tcp-connect|udp-listen|udp-connect)/i },
  { id: "no-dns-config", re: /\b(config\.yml|cloudflared.*(config|dns)|wrangler.*(dns|tunnel)|nsupdate)\b/i },
  { id: "no-force-git", re: /\bgit\b[^\n]*\b(push\s+(-f|--force)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|rebase\s+--force|filter-branch)\b/i },
  { id: "no-system-mutate", re: /\b(reg\s+delete|netsh\s+.*(add|delete|set)|net\s+user|sc\s+delete|diskpart|format\s+[a-zA-Z]:|bcdedit|takeown|icacls\s+.*\/(grant|deny)|taskkill\s+\/f\s+\/pid\s+0)\b/i },
  { id: "no-secrets-write", re: /(\b|\\|\.)(token|secret|password|api[_-]?key)\b[^\n]*(>|>>|set\s+[A-Z_]+=|echo)/i },
  { id: "no-second-server", re: /\b(vite(\.js)?\b[\s\S]{0,80}--port\s*5173|\bnode(?:\.exe)?\s+server\.mjs\b)/i },
  { id: "no-self-image-api", re: /\b(curl|wget|Invoke-WebRequest|\birm\b|\biwr\b)\b[\s\S]{0,400}\/api\/image\b/i },
];

// ── 受保护路径（仓库法律：只读不写，写操作直接拒绝）──
export const PROTECTED_PATHS = [
  /(^|[\\/])APPEND_SYSTEM\.md$/i,
  /(^|[\\/])SOUL$/i,
  /(^|[\\/])IDENTITY$/i,
  /(^|[\\/])宪法\.json$/,
  // 人格定义（2026-09-18）：一份定义决定人格 → 它与人格本身同级保护，工具层只读不写；
  // 要改走"提案 → 人批准 → 落地"（memory-stages 的草案区机制）。
  /(^|[\\/])人格定义\.json$/,
  /\.token$/i,
];

export function isProtectedPath(p) {
  const abs = path.resolve(p || "").replace(/\\/g, "/");
  return PROTECTED_PATHS.some((re) => re.test(abs));
}

// 危险命令拦截（防 prompt injection / 幻觉触发不可逆操作）
export const DANGEROUS_CMD_RE = /^\s*(rm\s+(-rf|-r|-f)?|format\s+[a-zA-Z]:|del\s+\/[sf]|rd\s+\/s|shutdown|taskkill\s+\/f|reg\s+delete|diskpart|mkfs|dd\s+if=)/i;

// pi CLI 有效子命令（无效子命令会被 pi 当消息参数启动交互会话 → 挂 5 分钟）
export const PI_CMDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth", "--help", "-h", "--version", "-v", "--provider", "--model", "--print", "-p", "--continue", "-c", "--resume", "-r"]);

// 交互式命令（无输出、挂起等待输入）
export const INTERACTIVE_CMD_RE = /^(pip|npm|npx|yarn|pnpm|git)\s+(login|init\s+-y?)/i;

// ── 红线判定前的命令归一（2026-10-06）──
// 真机误伤：`grep -rn "token" x 2>/dev/null` 被 no-secrets-write 拦（token 后面有个 >），
// `grep -n "cloudflared" server.mjs` 被 no-tunnel 拦。查源码不是写密钥，也不是开隧道。
// 归一只做三件事，红线本身一条不改：
//   ① 丢掉无害重定向（2>/dev/null、>nul、2>&1）；
//   ② 按 ; && || 换行切成独立语句（引号内不切），每句单独判，"grep token" 和 "echo ---" 不再拼成一条；
//      管道 | 不切——数据顺着管道流，`printenv | grep TOKEN > x` 仍是一句、照拦；
//   ③ 语句里没有写文件的重定向时，搜索命令（grep/rg/findstr/Select-String…）去掉「搜索词」，
//      文件路径保留（grep x ~/.cloudflared/config.yml 照拦）。
const HARMLESS_REDIRECT_RE = /(^|\s)(?:\d?>>?|&>)\s*(?:\/dev\/null|nul)(?=\s|$|[;|&])|(^|\s)\d?>&\d(?=\s|$|[;|&])/gi;
const SEARCH_CMDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "findstr", "select-string", "sls"]);
const PATTERN_OPTS = new Set(["-e", "--regexp", "-pattern"]);

// 引号感知地切；pipes=true 切管道级，否则切语句级（; && || & 换行）。
export function splitShellSegments(cmd, { pipes = false } = {}) {
  const out = [];
  const s = String(cmd || "");
  let cur = "", q = "";
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q) q = ""; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (pipes) {
      if (ch === "|") { flush(); continue; }
    } else if (ch === ";" || ch === "\n") { flush(); continue; }
    else if ((ch === "&" || ch === "|") && s[i + 1] === ch) { flush(); i++; continue; }
    else if (ch === "&" && s[i - 1] !== ">" && s[i + 1] !== ">") { flush(); continue; }
    cur += ch;
  }
  flush();
  return out;
}

function shellTokens(seg) {
  const toks = [];
  let cur = "", q = "", has = false;
  for (const ch of seg) {
    if (q) { if (ch === q) q = ""; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) toks.push(cur); cur = ""; has = false; continue; }
    cur += ch;
  }
  if (has || cur) toks.push(cur);
  return toks;
}

function stripSearchPattern(seg) {
  const toks = shellTokens(seg);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  if (toks[i] === "git" && toks[i + 1] === "grep") i += 2;
  else if (SEARCH_CMDS.has(String(toks[i] || "").toLowerCase())) i += 1;
  else return seg;
  const kept = toks.slice(0, i);
  let sawPattern = false;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (PATTERN_OPTS.has(t.toLowerCase())) { sawPattern = true; i++; continue; }
    if (t.startsWith("--regexp=") || (/^-e./.test(t) && !t.startsWith("--"))) { sawPattern = true; continue; }
    if (t.startsWith("-") || /^\d+$/.test(t)) { kept.push(t); continue; }
    if (!sawPattern) { sawPattern = true; continue; }
    kept.push(t);
  }
  return kept.join(" ");
}

// 红线判定用的命令段（归一后）。dsh-keys 的策略规则也走它，两处口径一致。
export function denyCheckSegments(cmd) {
  const cleaned = String(cmd || "").replace(HARMLESS_REDIRECT_RE, " ");
  return splitShellSegments(cleaned).map((stmt) => {
    if (/>/.test(stmt.replace(/(['"])(?:(?!\1).)*\1/g, ""))) return stmt; // 写文件的句子原样判
    return splitShellSegments(stmt, { pipes: true }).map(stripSearchPattern).join(" | ");
  }).filter(Boolean);
}

// 命中任一 deny 规则 → { id }；未命中 → null
export function matchDenyRule(cmd) {
  const segs = denyCheckSegments(cmd);
  for (const rule of USER_DENY_PATTERNS) {
    if (segs.some((seg) => rule.re.test(seg))) return rule;
  }
  return null;
}

// 模型常把 git-bash 写法带进文件工具：/d/pi-workspace/x、/tmp/x、~/x。
// 不归一的话 /d/... 会被当成「当前盘根下的 d 目录」，工作区里的文件也报越界。
export function normalizeToolPath(p, { platform = process.platform, home = os.homedir(), tmp = os.tmpdir() } = {}) {
  const s = String(p ?? "");
  if (!s) return s;
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) return path.join(home, s.slice(2));
  if (platform !== "win32") return s;
  const m = s.match(/^\/(?:cygdrive\/|mnt\/)?([a-zA-Z])(\/.*)?$/);
  if (m) return `${m[1].toUpperCase()}:${m[2] || "/"}`;
  if (s === "/tmp" || s.startsWith("/tmp/")) return path.join(tmp, s.slice(5));
  return s;
}

// 工作空间路径安全：解析后必须落在 root 内（防 ../ 越权 + symlink 越权）
export function safeJoin(root, p) {
  const resolved = path.resolve(root, String(p || "").replace(/^\/+/, ""));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  // P1 安全加固：symlink 越权防护——解析真实路径后再校验边界
  try {
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      const rootReal = fs.realpathSync(root);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
    }
  } catch {}
  return resolved;
}
