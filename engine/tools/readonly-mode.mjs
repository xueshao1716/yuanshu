// ===== readonly-mode.mjs —— 只读模式（2026-10-28）=====
//
// 起因：bash 没有 OS 沙箱，"这次只想让它看看"和"这次允许它改"在工具层没区别。
// 这里给一个会话/全局开关：打开后 bash 只允许**读类命令**，写命令一律拒。
//
// 开关来源（任一命中即只读）：
//   · 环境变量 YUANSHU_READONLY=1
//   · <ws>/记忆/运行时/只读模式.json  {"on": true}
import fs from "node:fs";
import path from "node:path";

export const READONLY_REL = path.join("记忆", "运行时", "只读模式.json");

// 允许的读类命令前缀（只认第一个词；管道/重定向另外判）
const READ_ONLY_CMDS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "less", "more", "grep", "rg", "find", "fd",
  "wc", "sort", "uniq", "cut", "awk", "sed",  // sed 不带 -i 才只读，见下
  "git", "node", "npm", "pnpm", "python", "python3", "pip", "tsc", "eslint", "prettier",
  "echo", "printf", "date", "whoami", "pwd", "cd", "which", "where", "stat", "file",
  "jq", "curl", "wget", "du", "df", "ps", "tasklist", "netstat", "tree", "diff", "md5sum", "sha256sum",
]);

// 这些写法在"读类命令"里出现也算写
const WRITE_MARKERS = [
  />>?\s*[^&|]/,            // 重定向写文件（> file / >> file）
  /\bsed\s+(-i|--in-place)\b/,
  /\bgit\s+(commit|push|merge|reset|checkout|clean|rebase|apply|am)\b/,
  /\b(npm|pnpm)\s+(install|i|add|remove|uninstall|update)\b/,
  /\b(python|python3|pip)\s+(install|uninstall)\b/,
  /\bnode\s+-e\b/,
  /\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b/,
];

export function readOnlyOn(wsRoot, env = process.env) {
  if (String(env.YUANSHU_READONLY || "") === "1") return { on: true, source: "env" };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(String(wsRoot || "."), READONLY_REL), "utf8"));
    if (raw && raw.on === true) return { on: true, source: "file" };
  } catch {}
  return { on: false, source: "" };
}

/** 只读模式下这条命令允许吗。 */
export function allowInReadOnly(cmd) {
  const text = String(cmd || "").trim();
  if (!text) return { ok: false, reason: "空命令" };
  // 复合命令逐段看
  for (const seg of text.split(/&&|\|\||;|\|/)) {
    const t = seg.trim();
    if (!t) continue;
    const first = (t.match(/^([a-zA-Z0-9_.-]+)/) || [])[1] || "";
    if (!READ_ONLY_CMDS.has(first)) return { ok: false, reason: `「${first || t.slice(0, 20)}」不在只读白名单` };
    for (const re of WRITE_MARKERS) if (re.test(t)) return { ok: false, reason: `含写操作（${re.source.slice(0, 24)}）` };
  }
  return { ok: true };
}

export function setReadOnly(wsRoot, on) {
  const file = path.join(String(wsRoot || "."), READONLY_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ on: !!on, at: Date.now() }, null, 2), "utf8");
  return { ok: true, on: !!on };
}
