// ===== secrets-guard.mjs —— 凭据防护（对话通道工具层，2026-08-30）=====
// 背景：unifiedChat 通道经 cloudflared 公网暴露，模型（含第三方免费模型）可调
// read/bash 工具。曾实测：模型用 bash type 读出 auth.json 里真实 API key。
//
// 设计（三层防线）：
//   ① 输入层：read/write/edit 的路径命中敏感文件名 → 拒绝
//   ② 输入层：bash 命令字符串引用敏感文件名 → 拒绝
//   ③ 输出层：所有工具输出过密钥值正则 → 兜底脱敏（防①②漏网，如 python 读文件）
//
// 白名单边界：守卫只作用于 unifiedChat 对话通道的工具。宿主（小语本体/ pi agent
// 通道）不经此层——密钥管理是宿主职权。对话通道不见明文密钥，但 read/bash 命中
// 凭据文件时改走密文通道提示（list_channels / generate_*），不再死拒把活停掉。
// 写/改密钥文件仍拒绝。

import path from "node:path";

// ── 敏感文件名（basename 级匹配，任意目录下命中即拦）──
export const SENSITIVE_BASENAME_RE = /(^|[\\/])(\.token|\.env(\..+)?|auth\.json|auth-store\.json|id_rsa[^\\/]*|id_ed25519[^\\/]*|id_ecdsa[^\\/]*|credentials?\.json|secrets?\.json|secret[^\\/]*\.(?:json|ya?ml|txt)|[^\\/]*\.pem|[^\\/]*\.key|\.npmrc|\.netrc|\.wgetrc|\.git-credentials|service-account[^\\/]*\.json)$/i;

// ── 密钥值模式（输出脱敏用，宁多勿漏）──
const SECRET_VALUE_RES = [
  { re: /\bsk-[A-Za-z0-9_-]{12,}/g, label: "sk密钥" },                 // OpenAI/DeepSeek/OpenRouter/51relay 等
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, label: "GitHub令牌" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AWS密钥" },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, label: "Google密钥" },
  { re: /\bgsk_[A-Za-z0-9]{20,}/g, label: "Groq密钥" },
  { re: /\bxox[bpars]-[A-Za-z0-9-]{10,}/g, label: "Slack令牌" },
  { re: /\beyJ[A-Za-z0-9_-]{40,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, label: "JWT" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, label: "PEM私钥" },
  { re: /"(api[-_]?key|apikey|secret|token|password|access[-_]?token)"\s*:\s*"([^"]{8,})"/gi, label: "KV凭据" },
];

export function isSensitivePath(p) {
  const abs = path.resolve(String(p || "")).replace(/\\/g, "/");
  const base = abs.split("/").pop() || "";
  return SENSITIVE_BASENAME_RE.test("/" + base) || SENSITIVE_BASENAME_RE.test(abs);
}

// bash 命令里是否引用了敏感文件（字符串级检查——简单但有效，配合③兜底）
export function commandTouchesSensitive(cmd) {
  const s = String(cmd || "");
  const candidates = s.match(/[A-Za-z]:[\\/][^\s"'|;&<>]*|(^|[\s"'/])[^\s"'|;&<>]+\.(json|pem|key|token|env)\b/gi) || [];
  for (const c of candidates) {
    if (isSensitivePath(c.replace(/^[^A-Za-z]*/, ""))) return true;
  }
  // 无路径上下文但裸提敏感名（如 type auth.json / cat .env）
  return /(^|[\s"'=])(\.token|auth\.json|auth-store\.json|\.env|id_rsa|credentials\.json|secrets?\.json)([\s"'&|;<>]|$)/i.test(s);
}

export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const { re } of SECRET_VALUE_RES) {
    out = out.replace(re, (m) => (m.startsWith("-----") ? m : m.slice(0, 6) + "***[已脱敏]"));
  }
  return out;
}
