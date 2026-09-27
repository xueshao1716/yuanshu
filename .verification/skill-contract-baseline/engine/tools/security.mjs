// ===== security.mjs —— 工具层安全原语（从 server.mjs 抽离，纯函数无状态）=====
// 三层防线：User 层 deny 规则（宪法红线）→ 危险/交互命令拦截 → 受保护路径只读。
// 任何 allow 都不能覆盖 deny；命中即拒绝并给出规则 id 方便排查。

import path from "node:path";
import fs from "node:fs";

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

// 命中任一 deny 规则 → { id }；未命中 → null
export function matchDenyRule(cmd) {
  for (const rule of USER_DENY_PATTERNS) {
    if (rule.re.test(cmd)) return rule;
  }
  return null;
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
