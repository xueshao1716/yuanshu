// 元枢 ↔ TUI 记忆同步脚本
// 作用：把元枢的记忆文件（记忆.md/记忆日志/经验库）同步到 TUI 项目级 APPEND_SYSTEM.md
// 这样 TUI 在工作空间下运行时，加载同一份记忆，两端记忆相通
//
// 2026-11-08：生成物里还要带**人格块**（见下面 applyPersonaBlock）。以前人格块是手写进这个文件的，
// 下一次记忆同步整体重写就消失——前台于是永远看不到最新外貌。现在人格块由生成器自己产出。
import fs from "node:fs";
import { atomicWriteText } from "../atomic-io.mjs";
import path from "node:path";
import os from "node:os";
import { env } from "../env.mjs";
import { existingWorkspace } from "../workspace-default.mjs";
import { watchMemorySources } from './source-watch.mjs';
import { loadPersonaDefinition, renderAppendSystemPersona, PERSONA_BEGIN, PERSONA_END } from "../persona-def.mjs";

// M1 路径外部化：工作空间根不再写死盘符——
// 优先 initMemorySync(wsRoot) 注入，再读 YUANSHU_CWD / PI_WEB_CWD，最后探测默认目录。
let _wsOverride = "";
let stopWatching;
export function initMemorySync({ wsRoot, watch = false, interval = 1000 } = {}) {
  stopWatching?.();
  stopWatching = null;
  if (wsRoot) _wsOverride = wsRoot;
  if (watch) stopWatching = watchMemorySources(WS(), syncMemoryToTui, interval);
}
function defaultWs() {
  if (env("CWD")) return env("CWD");
  return existingWorkspace() || process.cwd();
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

// ── 人格块（2026-11-08 根因修复：人格/形象被记忆同步覆盖）────────────────────
// 症状：改了 记忆/人格定义.json 的外貌，前台一直看不到最新形象。
// 根因不是渲染，而是**这个生成器**：它每次把整个文件重写一遍，手写进去的人格块下一次同步就没了；
// 只剩 server.mjs 那个 10 分钟一次的人格核对在补，补完又被下一次记忆同步抹掉，来回拉锯。
// 修法：人格块由生成器自己产出——每次同步用 记忆/人格定义.json 现渲染一份，插在宪法块之后、
// 工作空间记忆之前。定义变了自然重渲染；没变就是同一段（幂等，不叠加，不覆盖别的段落）。
export const PERSONA_ANCHOR = "## 固定记忆（记忆.md）";

/**
 * 剥掉已有的人格块（纯函数）。
 * 只按 PERSONA_BEGIN / PERSONA_END 定位，连插入时补在块后面的那个空行一起剥；
 * 剥完必须与插入前逐字节相同——否则每次同步都会“漂”出一点空白，久了就成大 diff。
 */
export function stripPersonaBlock(text = "") {
  let out = String(text ?? "");
  for (let guard = 0; guard < 20; guard++) {
    const a = out.indexOf(PERSONA_BEGIN);
    if (a < 0) break;
    const b = out.indexOf(PERSONA_END, a);
    if (b < 0) break; // 标记不成对：原样不动，宁可不改也不误删半段
    let stop = b + PERSONA_END.length;
    if (out.startsWith("\r\n\r\n", stop)) stop += 4;
    else if (out.startsWith("\n\n", stop)) stop += 2;
    else if (out.startsWith("\r\n", stop)) stop += 2;
    else if (out.startsWith("\n", stop)) stop += 1;
    out = out.slice(0, a) + out.slice(stop);
  }
  return out;
}

/**
 * 先剥旧块再插新块（纯函数，单测直接打这里）。
 * 插入点：PERSONA_ANCHOR（工作空间记忆标题）之前 —— 也就是宪法块与其分隔线之后；
 * 其余内容一个字节都不碰。重复调用输出相同，所以重复跑不会叠加。
 */
export function applyPersonaBlock(content = "", personaBlock = "") {
  const base = stripPersonaBlock(content);
  if (!personaBlock) return base;
  const at = base.indexOf(PERSONA_ANCHOR);
  if (at < 0) return `${personaBlock}\n\n${base}`; // 结构不认识时保守前置，绝不覆盖原文
  return `${base.slice(0, at)}${personaBlock}\n\n${base.slice(at)}`;
}

/** 从 记忆/人格定义.json 现渲染人格块；读不到就返回空串（本次不写人格块，其余内容照常生成） */
export function renderPersonaForAppend() {
  try {
    const { def } = loadPersonaDefinition(WS());
    return renderAppendSystemPersona(def);
  } catch (e) {
    console.log("[memory-sync] ⚠️ 人格定义渲染失败，本次不写人格块:", String(e?.message || e).slice(0, 100));
    return "";
  }
}

/** 纯函数：把各段拼成 APPEND_SYSTEM.md 全文（人格块按标记幂等插入） */
export function buildAppendSystemContent({ memory = "", log = "", experience = "", skills = "", constitution = "", persona = "" } = {}) {
  const expRecent = experience ? experience.split(/\n### /).slice(-6).map(b => "### " + b.trim()).join("\n") : "";
  const logRecent = log ? log.split("\n### ").slice(-8).map(b => "### " + b.trim()).join("\n") : "";
  const base = `# 小语 · 工作空间记忆（TUI 与元枢共享）

> 本文件由记忆同步脚本自动生成，与元枢共享同一份记忆。
> 修改请改源文件（记忆.md / 记忆日志.md / 经验库 / 宪法.json），勿直接编辑本文件。

${constitution ? `${constitution}\n\n---\n\n` : ""}## 固定记忆（记忆.md）

${memory || "（无）"}

## 技能记忆（记忆/技能记忆.md）

${skills || "（无）"}

## 最近记忆日志

${logRecent || "（无）"}

## 经验库最近条目

${expRecent || "（无）"}
`;
  return applyPersonaBlock(base, persona);
}

export function syncMemoryToTui() {
  try {
    const memory = read(path.join(WS(), "记忆.md"));
    const log = read(path.join(WS(), "记忆", "记忆日志.md"));
    const exp = read(path.join(WS(), "工程", "经验库", "experience.md"));
    const skills = read(path.join(WS(), "记忆", "技能记忆.md"));

    const constitution = renderConstitution();
    // 人格块跟着记忆同步一起走：定义变了这里就是新的一份，定义没变就是原文
    const persona = renderPersonaForAppend();

    const content = buildAppendSystemContent({ memory, log, experience: exp, skills, constitution, persona });
    if (read(OUT()) === content.trim()) return true;
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
