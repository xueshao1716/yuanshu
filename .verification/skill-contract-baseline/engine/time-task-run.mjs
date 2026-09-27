// 定时任务执行材料：注入昨日会话（索引 + 正文）/记忆/上次兑现，只给只读工具，禁止模型交填空框架
//
// 2026-09-15 补三处（此前反思只能谈后端，谈不了聊天）：
//   ① **会话正文**：原先每个会话只给「名字 + preview」，而 preview 是第一条用户消息截 60 字
//      （`session-files.mjs:113`）——反思对"用户聊了什么"只知道开场一句，对"引擎做了什么"
//      却有 6000 字记忆日志。材料差两个数量级，它当然只谈后端。现在按会话读取昨日消息正文。
//   ② **上次兑现**：反思原先拿不到自己上轮的行动清单，只能每天从头复盘，无法检查兑现。
//      现在把反思产生的承诺（承诺账里 source=reflect 的那些）连同状态一起喂回去。
//   ③ **行动清单契约**：复盘结尾必须附一个 JSON 块，由 `recordReflectionActions` 解析后
//      写进承诺账——这样"今天要做的"才变成可追踪、会被追问兑现的对象，而不是写完就没了。
import fs from "node:fs";
import path from "node:path";
import { splitLogBlocks } from "./memory-facts.mjs";
import { readEntriesFromFile } from "./session-files.mjs";
import { extractMessages } from "./session-utils.mjs";
import { loadPromises, recordPromises } from "./promises.mjs";
import { normalizeActionKind } from "./reflection-exec.mjs";

const READ_TOOLS = new Set(["read", "web_search", "search_files"]);
const CLIP_CAP = 6000;
const BODY_SESSIONS = 6;          // 最多读几个会话的正文
const BODY_PER_SESSION = 1800;    // 每个会话正文上限
const BODY_TOTAL = 9000;          // 正文总量上限
const BODY_LINE = 300;            // 单条消息截断

/** 反思产生的承诺用这个 sessionId 标记，便于"上次兑现"把它们挑出来。 */
export const REFLECTION_SOURCE = "reflect";

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function ymdOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function yesterdayYmd(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return ymdOf(d);
}

export function toLocalYmd(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) return ymdOf(d);
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function formatSession(s) {
  const name = String(s?.name || "未命名").slice(0, 40);
  const preview = String(s?.preview || "").replace(/\s+/g, " ").slice(0, 80);
  return preview ? `- ${name}｜${preview}` : `- ${name}`;
}

function clipMemoryLog(wsRoot, ymd) {
  const fp = path.join(wsRoot, "记忆", "记忆日志.md");
  if (!fp || !fs.existsSync(fp)) return "";
  let raw = "";
  try { raw = fs.readFileSync(fp, "utf8"); } catch { return ""; }
  const hits = splitLogBlocks(raw).blocks.filter((b) => b.includes(ymd) && !/^- status:\s*superseded\b/m.test(b));
  return hits.join("\n\n").slice(0, CLIP_CAP);
}

/**
 * 一个会话在目标日期里的正文（用户提问 + 小语结论）。
 * 只取当天消息；工具调用/结果不进（反思要的是"聊了什么、交付了什么"，不是执行细节）。
 */
export function sessionDigest(file, ymd, budget = BODY_PER_SESSION) {
  try {
    if (!file || !fs.existsSync(file)) return "";
    const msgs = extractMessages(readEntriesFromFile(file));
    const lines = [];
    let used = 0;
    for (const m of msgs) {
      if (m?.role !== "user" && m?.role !== "assistant") continue;
      if (toLocalYmd(m.ts) !== ymd) continue;
      const text = String(m.text || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const line = `${m.role === "user" ? "用户" : "小语"}：${text.slice(0, BODY_LINE)}`;
      if (used + line.length > budget) break;
      lines.push(line);
      used += line.length;
    }
    return lines.join("\n");
  } catch { return ""; }
}

/** 上次复盘的行动清单 + 现在的兑现情况（来自承诺账，结清与否是明确记录，不是模型自述）。 */
export function collectReflectionCommitments(wsRoot, { fsMod = fs } = {}) {
  let all = [];
  try { all = loadPromises(wsRoot, fsMod); } catch { return { open: [], closed: [] }; }
  const mine = all.filter((p) => String(p.sessionId || "") === REFLECTION_SOURCE);
  const now = Date.now();
  const age = (p) => {
    const t = new Date(p?.at).getTime();
    if (!Number.isFinite(t)) return "时间未知";
    const days = Math.floor(Math.max(0, now - t) / 86400000);
    return days <= 0 ? "今天" : days === 1 ? "昨天" : `${days} 天前`;
  };
  return {
    open: mine.filter((p) => p.status === "pending").map((p) => ({ text: p.text, phrase: age(p), due: p.due })),
    closed: mine.filter((p) => p.status !== "pending").slice(-8).map((p) => ({ text: p.text, status: p.status, evidence: p.evidence })),
  };
}

function formatCommitments(c) {
  if (!c || (!c.open?.length && !c.closed?.length)) return "（还没有历史行动清单）";
  const parts = [];
  if (c.open?.length) {
    parts.push(`仍挂着（${c.open.length}）：\n` + c.open.slice(0, 8).map((x) => `- ${x.phrase}：${x.text}`).join("\n"));
  }
  if (c.closed?.length) {
    parts.push(`已结清（${c.closed.length}）：\n` + c.closed.map((x) => `- ${x.text}${x.evidence ? `（证据：${x.evidence}）` : "（无证据）"}`).join("\n"));
  }
  return parts.join("\n\n");
}

export function collectTimeTaskBrief({ wsRoot, sessions = [], now = new Date(), fsMod = fs } = {}) {
  const ymd = yesterdayYmd(now);
  const list = Array.isArray(sessions) ? sessions : [];
  const matched = list.filter((s) => toLocalYmd(s.updatedAt || s.createdAt) === ymd);
  const sessionLines = matched.slice(0, 12).map(formatSession);
  const recentLines = matched.length ? [] : list.slice(0, 8).map(formatSession);
  // ① 会话正文：反思此前只看得到开场那 60 字
  const bodies = [];
  for (const s of matched.slice(0, BODY_SESSIONS)) {
    const body = sessionDigest(s.file, ymd, BODY_PER_SESSION);
    if (body) bodies.push(`### ${String(s.name || "未命名").slice(0, 40)}\n${body}`);
  }
  return {
    ymd,
    sessionLines,
    recentLines,
    sessionBodies: bodies.join("\n\n").slice(0, BODY_TOTAL),
    memoryClip: clipMemoryLog(wsRoot, ymd),
    commitments: formatCommitments(collectReflectionCommitments(wsRoot, { fsMod })),
  };
}

export function buildTimeTaskPrompt(task, brief = {}) {
  const ymd = brief.ymd || "";
  const sessions = (brief.sessionLines || []).join("\n") || "（记录里没有昨日会话）";
  const recent = (brief.recentLines || []).length
    ? `\n【近期会话（非昨日，仅参考）】\n${brief.recentLines.join("\n")}\n`
    : "";
  const bodies = String(brief.sessionBodies || "").trim()
    ? `\n【昨日会话正文（用户问了什么、小语答了什么）】\n${brief.sessionBodies}\n`
    : "";
  const commitments = String(brief.commitments || "").trim()
    ? `\n【上次复盘的行动清单与兑现情况】\n${brief.commitments}\n`
    : "";
  const memory = brief.memoryClip || "（记录里没有昨日记忆日志）";
  return `${task?.prompt || "对前一日工作与成长复盘"}
（定时任务到点触发，直接写完整复盘，不要反问。）

复盘对象日期：${ymd}
【昨日会话】
${sessions}
${bodies}${commitments}【昨日记忆日志摘录】
${memory}

硬约束：
- 必须根据上方真实材料写完整复盘，禁止输出填空框架/占位符（如「列出昨天完成的3-5件」）。
- 禁止声称无法读取聊天记录或工作数据；材料不够就写「记录里没有」。
- 表格必须有数据行，没有事实就不要建空表。
- **必须覆盖会话侧**：用户在聊天里要了什么、交付到什么程度、有没有留在「记录里没有」的地方。
  不能只谈引擎/后端的工作——会话正文就在上方。
- 若上面有【上次复盘的行动清单与兑现情况】，先逐条交代兑现与否，再说今天。
- 需要细节可 read 记忆.md、记忆/记忆日志.md 或会话文件；不要 bash/write。

结尾必须再附一个 JSON 代码块（只能是 JSON，前后不要解释），列出你今天要做的行动：
\`\`\`json
{"actions":[{"text":"要做什么（≤60字，具体到可核查）","kind":"fix|track|ask","due":"可选，ISO 日期，没有就空"}]}
\`\`\`
3-7 条。只写你确实打算做的。写下来就会进承诺账，下一轮复盘会被追问兑现。

**kind 怎么填（2026-09-17 起，这决定了谁会去做）**：
- \`fix\`：当场能修好的（改代码/补测试/改配置/补文档/沉淀技能），**新一轮会自动挑最多 3 条去执行**，
  执行轮必须交证据（命令 + 输出 + 改动文件）。所以 kind=fix 的动作要写成**可直接动手**的一句话，
  不要写"考虑一下""评估是否"这类没法验收的。
- \`track\`：要跨天跟踪、依赖别的进展、或一次做不完的。
- \`ask\`：需要人拍板的（改产品行为、权限、外部账号、花钱、删数据、部署发布）。
写错 kind 的代价是双向的：把该问人的写成 fix，会被自动执行轮挡回 blocked；把能当场做的写成 track，
就永远是清单上的一条。`;
}

export function composeTimeTaskMessages(task, ctx) {
  return [{ role: "user", content: buildTimeTaskPrompt(task, collectTimeTaskBrief(ctx)) }];
}

export function timeTaskReadTools(all = []) {
  return (Array.isArray(all) ? all : []).filter((t) => READ_TOOLS.has(t?.function?.name || t?.name));
}

/**
 * 解析复盘结尾的行动清单。取**最后**一个 json 块（模型有时先给示例再给正式块），
 * 解析失败就返回空——不猜、不拼。
 */
export function parseReflectionActions(text) {
  const blocks = [...String(text || "").matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const d = JSON.parse(blocks[i][1]);
      if (!Array.isArray(d?.actions)) continue;
      return d.actions
        .filter((a) => a && String(a.text || "").trim().length >= 4)
        .slice(0, 10)
        .map((a) => ({
          text: String(a.text).trim().slice(0, 120),
          due: a.due ? String(a.due) : null,
          // 2026-09-17：行动自报能不能当场做（fix / track / ask）。没写按 track，
          // 由 engine/reflection-exec.mjs 决定谁进自动执行、谁留给人和跨天跟踪。
          kind: normalizeActionKind(a.kind),
        }));
    } catch { /* 试上一块 */ }
  }
  return [];
}

/**
 * 把复盘的行动清单写进承诺账（source=reflect）。
 * 这样"今天要做的"才可追踪：下一轮复盘会看到它、台前「待兑现承诺」会列它、
 * 结清仍只能由人给结论（承诺账的既有规矩）。
 */
export function recordReflectionActions(wsRoot, text, { taskId = "", now = new Date(), fsMod = fs } = {}) {
  const actions = parseReflectionActions(text);
  if (!actions.length) return { ok: false, reason: "复盘没有给出可解析的行动清单", added: 0, actions: [] };
  const at = (now instanceof Date ? now : new Date()).toISOString();
  const stamp = Date.now().toString(36);
  const list = actions.map((a, i) => {
    const due = a.due ? new Date(a.due) : null;
    return {
      id: `r_${stamp}_${i}`,
      at,
      sessionId: REFLECTION_SOURCE,
      taskId: taskId || null,
      text: a.text,
      // kind 也落账：下一轮"上次兑现"能看出哪条本该当场做掉却没做
      kind: a.kind,
      due: due && !Number.isNaN(due.getTime()) ? due.toISOString() : null,
      status: "pending",
      evidence: null,
      closedAt: null,
    };
  });
  const r = recordPromises(wsRoot, list, fsMod);
  return { ok: true, parsed: actions.length, added: r?.added || 0, actions };
}
