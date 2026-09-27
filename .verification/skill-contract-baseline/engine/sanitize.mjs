// 元枢敏感信息脱敏模块（借鉴 badlogic/pi-share-hf 思路）
// 分享/导出前自动擦除：API Key、访问令牌、token、密码等
import path from "node:path";
import os from "node:os";

// 常见的敏感模式（正则，按序替换）
const PATTERNS = [
  // OpenAI/DeepSeek 风格 key：sk- 开头
  [/sk-[A-Za-z0-9_-]{16,}/g, "sk-***[已脱敏]"],
  // 通用 token：tp- / ark- / agnes- 等
  [/[a-z]+-[A-Za-z0-9]{20,}/g, "***[已脱敏]"],
  // 访问令牌：love#xxx 或长 hex
  [/love#[A-Za-z0-9]+/g, "love#***[已脱敏]"],
  // 长 hex（32+ 位，常见 token）
  [/\b[0-9a-f]{32,}\b/gi, "[已脱敏]" ],
  // Bearer / Authorization 头
  [/(Bearer|Authorization)[:\s]+[A-Za-z0-9._\-]+/gi, "$1: ***[已脱敏]"],
  // 密码字段
  [/(password|passwd|pwd|api[_-]?key|secret|token)\s*[:=]\s*["']?[^"'\s,}]+/gi, "$1: ***[已脱敏]"],
];

// 读取 auth.json 里的真实 key，确保脱敏覆盖（即使格式特殊）
function loadSensitiveTokens() {
  const tokens = new Set();
  try {
    const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(require("node:fs").readFileSync(authPath, "utf8"));
    for (const [prov, cfg] of Object.entries(auth || {})) {
      if (!cfg || typeof cfg !== "object") continue;
      const key = cfg.key || "";
      if (typeof key === "string" && key.length > 8) tokens.add(key);
    }
  } catch {}
  return tokens;
}

// 对文本脱敏
export function sanitizeText(text) {
  if (!text) return text;
  let out = String(text);
  // 1. 正则模式替换
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  // 2. 真实 key 精确替换（从 auth.json 读取）
  for (const tk of loadSensitiveTokens()) {
    if (tk && out.includes(tk)) out = out.split(tk).join("***[已脱敏]");
  }
  return out;
}

// 对导出/分享的 HTML 或文本内容脱敏
export function sanitizeContent(content, format = "text") {
  const clean = sanitizeText(content);
  if (format === "html") {
    // HTML 里 key 可能被实体转义（& 等），先还原常见实体再脱敏
    const unescaped = clean
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    return sanitizeText(unescaped);
  }
  return clean;
}
