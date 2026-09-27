// 元枢 ↔ TUI 记忆同步脚本
// 作用：把元枢的记忆文件（记忆.md/记忆日志/经验库）同步到 TUI 项目级 APPEND_SYSTEM.md
// 这样 TUI 在 D:\pi-workspace 下运行时，加载同一份记忆，两端记忆相通
import fs from "node:fs";
import { atomicWriteText } from "./atomic-io.mjs";
import path from "node:path";
import os from "node:os";
import { env } from "./env.mjs";

// M1 路径外部化：工作空间根不再写死盘符——
// 优先 initMemorySync(wsRoot) 注入，再读 YUANSHU_CWD / PI_WEB_CWD，最后探测默认目录。
let _wsOverride = "";
export function initMemorySync({ wsRoot } = {}) { if (wsRoot) _wsOverride = wsRoot; }
function defaultWs() {
  if (env("CWD")) return env("CWD");
  for (const drive of ["D:", "E:", "C:"]) {
    const p = path.join(drive, path.sep === "\\" ? "pi-workspace" : "pi-workspace");
    try { if (fs.statSync(p).isDirectory()) return p; } catch {}
  }
  try { const p = path.join(os.homedir(), "pi-workspace"); if (fs.statSync(p).isDirectory()) return p; } catch {}
  return process.cwd();
}
const WS = () => _wsOverride || defaultWs();
const OUT = () => path.join(WS(), ".pi", "APPEND_SYSTEM.md");
const CONSTITUTION_FILE = () => path.join(WS(), "宪法.json");

function read(p) {
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; }
}

// ── 宪法渲染引擎（吸纳自 CodeWhale user_constitution.rs 的设计） ────────────
// 1. 只渲染 status=accepted 的条款——模型建议永远是 suggested，进不了 prompt
// 2. 禁止运行时策略键——宪法只能表达偏好，不能授予 shell/网络/审批权限
// 3. 防注入——未信任文本中和 <xiaoyu_constitution 标签序列 + 清理控制字符

// 运行时策略键：宪法文件里出现即拒绝渲染（防止模型借宪法自我授权）
const FORBIDDEN_RUNTIME_POLICY_KEYS = [
  "allow_shell", "approval_policy", "default_mode", "mcp_permissions",
  "mode", "network", "permission_mode", "permissions", "sandbox_mode", "trust",
];

// 中和 <xiaoyu_constitution 标签序列（大小写不敏感），防止伪造/闭合宪法信封
function neutralizeTagSequences(text) {
  return text.replace(/<\/?xiaoyu_constitution/gi, (m) => m.replace("<", "("));
}

function sanitizeUntrustedText(text) {
  const cleaned = String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return neutralizeTagSequences(cleaned);
}

// 确定性渲染：同数据永远同 prose（FNV-1a 64bit 摘要，同 CodeWhale 思路）
function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

function renderConstitution() {
  let raw;
  try { raw = fs.readFileSync(CONSTITUTION_FILE(), "utf8"); } catch { return null; }
  let doc;
  try { doc = JSON.parse(raw); } catch {
    console.log("[memory-sync] ⚠️ 宪法.json 解析失败，跳过宪法渲染");
    return null;
  }
  if (!doc || typeof doc !== "object") return null;

  // 禁止运行时策略键：顶层出现即拒绝整个文件（fail closed）
  for (const key of FORBIDDEN_RUNTIME_POLICY_KEYS) {
    if (key in doc) {
      console.log(`[memory-sync] ⚠️ 宪法含禁止的运行时策略键 "${key}"，拒绝渲染（宪法不能授权运行时权限）`);
      return null;
    }
  }

  const clauses = Array.isArray(doc.clauses) ? doc.clauses : [];
  // 只渲染 accepted（人类已批准的）条款，按 id 稳定排序（渲染确定性）
  const accepted = clauses
    .filter(c => c && typeof c === "object" && c.status === "accepted" && c.id && c.text)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  if (!accepted.length) return null;

  const lines = [];
  if (doc.about) lines.push(sanitizeUntrustedText(doc.about));
  lines.push("Ratified clauses (已批准条款，硬性)：");
  for (const c of accepted) {
    lines.push(`- ${sanitizeUntrustedText(c.text)}`);
  }
  const body = neutralizeTagSequences(lines.join("\n"));
  const digest = fnv1a64(body);
  const block = `<xiaoyu_constitution source="宪法.json" digest="${digest}">\n` +
    `小语与伙伴的宪法——比记忆层级更高，跨所有项目生效，作为硬性行为准则遵守。\n\n${body}\n</xiaoyu_constitution>`;
  return block;
}

export function syncMemoryToTui() {
  try {
    const memory = read(path.join(WS(), "记忆.md"));
    const log = read(path.join(WS(), "记忆", "记忆日志.md"));
    const exp = read(path.join(WS(), "工程", "经验库", "experience.md"));
    const skills = read(path.join(WS(), "记忆", "技能记忆.md"));

    const expRecent = exp ? exp.split(/\n### /).slice(-6).map(b => "### " + b.trim()).join("\n") : "";

    const constitution = renderConstitution();

    const content = `# 小语 · 工作空间记忆（TUI 与元枢共享）

> 本文件由记忆同步脚本自动生成，与元枢共享同一份记忆。
> 修改请改源文件（记忆.md / 记忆日志.md / 经验库 / 宪法.json），勿直接编辑本文件。

${constitution ? `${constitution}\n\n---\n\n` : ""}## 固定记忆（记忆.md）

${memory || "（无）"}

## 技能记忆（记忆/技能记忆.md）

${skills || "（无）"}

## 最近记忆日志

${log ? log.split("\n### ").slice(-8).map(b => "### " + b.trim()).join("\n") : "（无）"}

## 经验库最近条目

${expRecent || "（无）"}
`;
    fs.mkdirSync(path.dirname(OUT()), { recursive: true });
    atomicWriteText(OUT(), content);
    console.log(`[memory-sync] 已同步记忆到 TUI: ${OUT()} (${content.length}B)`);
    return true;
  } catch (e) {
    console.log("[memory-sync] 同步失败:", String(e?.message || e).slice(0, 100));
    return false;
  }
}

// 直接运行则同步一次（node memory-sync.mjs）
const isMain = process.argv[1] && fs.existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain || process.env.MEMORY_SYNC_RUN) {
  syncMemoryToTui();
}
