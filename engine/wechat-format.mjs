// ===== wechat-format.mjs —— 发出去之前怎么排版（2026-10-28）=====
//
// Hermes 的做法是**保留 Markdown**（它说 iLink 客户端能渲染表格/代码块）。
// 我们之前是**全剥掉**（stripMarkdownForWechat），理由是"微信不渲染"——但那是个人微信的经验，
// iLink Bot 消息可能不一样。所以做成可配置，默认按 Hermes 的做法保留，出问题改文件即可。
//
// 模式（<工作区>/记忆/运行时/微信格式.json: {"mode": "keep"}）：
//   keep  —— 原样保留（只折叠多余空行）
//   auto  —— 保留代码块/行内代码/表格/链接；标题降级成加粗；其余剥掉
//   strip —— 全剥（旧行为）
import fs from "node:fs";
import path from "node:path";
import { stripMarkdownForWechat } from "./wechat-ilink.mjs";

export const FORMAT_REL = path.join("记忆", "运行时", "微信格式.json");
export const MODES = ["keep", "auto", "strip"];

export function readFormatMode(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(String(wsRoot || "."), FORMAT_REL), "utf8"));
    if (raw && MODES.includes(raw.mode)) return raw.mode;
  } catch {}
  return "keep"; // 默认跟 Hermes 一致：保留
}

const collapse = (s) => String(s || "").replace(/\n{3,}/g, "\n\n").trim();

/** auto：保住有信息量的结构，丢掉装饰性语法。 */
export function autoFormat(text) {
  const src = String(text || "");
  const blocks = [];
  // 先把代码块抠出来，避免被后续正则破坏
  let t = src.replace(/```([\s\S]*?)```/g, (_m, code) => {
    blocks.push("```" + code + "```");
    return `\u0000CODE${blocks.length - 1}\u0000`;
  });
  t = t
    .replace(/^#{1,6}\s+(.+)$/gm, "$1")          // 标题 → 纯文本（下面会剥掉加粗）
    .replace(/^\s*[-*+]\s+/gm, "· ")               // 列表符号统一
    .replace(/\*\*([^*]+)\*\*/g, "$1")             // 加粗去掉（微信里就是同样字重）
    .replace(/`([^`]+)`/g, "$1")                   // 行内代码去反引号
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）"); // 链接 → 文字（地址）
  t = t.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => blocks[Number(i)] || "");
  return collapse(t);
}

/** 按模式格式化。 */
export function formatForWechat(text, mode = "keep") {
  const src = String(text || "");
  if (mode === "strip") return collapse(stripMarkdownForWechat(src));
  if (mode === "auto") return autoFormat(src);
  return collapse(src); // keep
}

/** 写一份配置文件（首次；已存在不覆盖）。 */
export function seedFormatConfig(wsRoot, mode = "keep") {
  const file = path.join(String(wsRoot || "."), FORMAT_REL);
  try {
    if (fs.existsSync(file)) return { ok: true, existed: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mode, note: "keep=保留Markdown / auto=保结构去装饰 / strip=全剥" }, null, 2), "utf8");
    return { ok: true, existed: false };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) } }
}
