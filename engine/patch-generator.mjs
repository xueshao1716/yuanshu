// ===== patch-generator.mjs —— 无人值守产出补丁（2026-10-26）=====
//
// 无人值守改代码是这套系统里风险最高的一件事，所以设计成"三道窄门"：
//   1. **生成器可插拔**：默认走本机 /api/chat（元枢自己），也可用 YUANSHU_PATCH_CMD 换成别的 CLI；
//   2. **只收 JSON 文件清单**：不许它自由发挥，只认 {"files":[{"path","content"}]}；
//   3. **白名单 + 限量**：文件必须在 PLAN 允许范围内，最多 5 个、每个不超过 20KB。
// 后面还有 patch-guard 的门禁与自动回滚兜底。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { allowedFromPlan, assertAllowed } from "./patch-guard.mjs";

export const MAX_FILES = 5;

/**
 * 兼容 CRLF/LF 的 find 匹配：先按原样找，找不到就试另一种行尾。
 * 2026-10-26 真机：模型按 `\n` 写 find，文件是 `\r\n`，校验直接判"找不到"。
 */
export function compatFind(content, find) {
  const text = String(content || "");
  const needle = String(find || "");
  const direct = text.indexOf(needle);
  if (direct >= 0) return { index: direct, find: needle };
  const toCrlf = needle.replace(/\r?\n/g, "\r\n");
  const i2 = text.indexOf(toCrlf);
  if (i2 >= 0) return { index: i2, find: toCrlf };
  const toLf = needle.replace(/\r\n/g, "\n");
  const i3 = text.indexOf(toLf);
  if (i3 >= 0) return { index: i3, find: toLf };
  return { index: -1, find: needle };
}
export const MAX_BYTES = 20_000;
export const MAX_EDITS = 8;
export const MAX_EDIT_BYTES = 12_000;

export const FULL_FILE_LIMIT = 24_000;
export const WINDOW_LINES = 40;
export const MAX_WINDOWS = 3;

/** 从症状里取关键词（中文两字以上 / 英文标识符），用于在大文件里定位。 */
export function keywordsOf(plan = {}) {
  const text = `${plan.title || ""} ${plan.symptom || ""} ${plan.focusHook || ""}`;
  const words = new Set();
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_.-]{3,}/g)) words.add(m[0]);
  for (const m of text.matchAll(/[\u4e00-\u9fa5]{2,6}/g)) words.add(m[0]);
  // 2026-10-26 真机：只从症状取词，命中的是 import 行；模型因此拒绝
  // （"job-state 的调用与重试逻辑未在片段中暴露"）。把**其它文件名**和**钩子符号**也算进来，
  // 才能真正定位到调用处。
  for (const f of plan.files || []) {
    const base = String(f).split("/").pop().replace(/\.(mjs|cjs|js|ts)$/, "");
    if (base.length >= 4) words.add(base);
  }
  for (const m of String(plan.focusHook || "").matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) words.add(m[0]);
  // 常见的调用/上报词（钩子里写中文时也能命中）
  for (const extra of ["syncReports", "collectJobs", "reportIncidents", "enqueueReport", "job_status", "detached"]) words.add(extra);
  return [...words].slice(0, 14);
}

/**
 * 给生成器看的"现有代码"：没有它，find/replace 无从谈起（真机：模型两次拒绝，理由都对）。
 * 小文件给全文；大文件给关键词附近的窗口，并明确标注省略。
 */
export function collectContext(repoRoot, plan = {}) {
  const files = (plan.files || []).slice(0, 6);
  const kws = keywordsOf(plan);
  const out = [];
  let budget = 120_000; // 总预算，防止提示词爆炸
  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    let text;
    try { text = fs.readFileSync(abs, "utf8"); } catch { continue }
    if (text.length <= FULL_FILE_LIMIT) {
      if (budget - text.length < 0) break;
      budget -= text.length;
      out.push({ path: rel, mode: "full", text });
      continue;
    }
    const lines = text.split(/\r?\n/);
    const hits = [];
    for (const kw of kws) {
      const idx = lines.findIndex((l) => l.includes(kw));
      if (idx >= 0 && !hits.some((h) => Math.abs(h - idx) < WINDOW_LINES)) hits.push(idx);
      if (hits.length >= MAX_WINDOWS) break;
    }
    const windows = (hits.length ? hits : [0]).slice(0, MAX_WINDOWS).map((idx) => {
      const from = Math.max(0, idx - Math.floor(WINDOW_LINES / 2));
      const to = Math.min(lines.length, from + WINDOW_LINES);
      return `--- 第 ${from + 1}~${to} 行 ---\n${lines.slice(from, to).join("\n")}`;
    });
    // 2026-10-26 真机：原来用 "\n" 拼，把文件的 CRLF 换成 LF；模型照着 LF 写 find，
    // 而文件是 CRLF → indexOf 永远失败（"找不到 find"）。这里保留原 EOL。
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const joined = windows.join(`${eol}${eol}// …（中间省略）…${eol}${eol}`);
    if (budget - joined.length < 0) break;
    budget -= joined.length;
    out.push({ path: rel, mode: "excerpt", text: joined, totalLines: lines.length });
  }
  return out;
}

function renderContext(ctx) {
  if (!ctx.length) return "";
  return [
    "## 现有代码（只读参考）",
    "下面是仓库里的**当前内容**。find 必须从这些文字里**逐字复制**（缩进也要一致）。",
    ...ctx.map((c) => `\n### ${c.path}${c.mode === "excerpt" ? `（共 ${c.totalLines} 行，只给相关片段）` : ""}\n\n` + "```\n" + c.text + "\n```"),
  ].join("\n");
}

/** 提示词：只让它产出 JSON，不给自由发挥空间。 */
export function buildPrompt(plan = {}, ctx = []) {
  return [
    "你在为一个自动化补丁管道写代码。严格按下面的计划改，只改计划里列出的文件。",
    "",
    `问题：${plan.title || ""}`,
    `症状：${plan.symptom || ""}`,
    plan.evidence?.length
      ? `证据：\n${plan.evidence.map((e) => (typeof e === "string" ? `- ${e}` : `- ${e?.source || "?"} · ${String(e?.id || "").slice(0, 24)}${e?.at ? ` · ${new Date(e.at).toISOString().slice(0, 16)}` : ""}`)).join("\n")}`
      : "",
    `允许改动的文件：${(plan.files || []).join(", ")}`,
    `验收标准：${plan.accept || ""}`,
    "",
    "要求：",
    "1. 只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码围栏。",
    "2. 两种写法，优先用第二种（大文件必须用它）：",
    '   a) 整文件替换：{"files":[{"path":"相对路径","content":"完整内容"}]}',
    '   b) 定点补丁：{"edits":[{"path":"相对路径","find":"原样出现的若干整行","replace":"替换成的若干整行"}]}',
    "      要求：find 必须在文件里**原样出现且只出现一次**（我会精确校验，不唯一就整体拒绝）。",
    "3. content 必须是**完整文件内容**（不是 diff），我会整文件替换。",
    `4. 整文件替换：最多 ${MAX_FILES} 个、每个 ≤${MAX_BYTES} 字节；定点补丁：最多 ${MAX_EDITS} 处、每处 ≤${MAX_EDIT_BYTES} 字节。`,
    "5. 如果无法在计划范围内解决问题，输出 {\"files\":[],\"note\":\"原因\"}。",
    "",
    renderContext(ctx),
  ].filter(Boolean).join("\n");
}

/** 从模型输出里抠出 JSON（容忍它包一层 ```json 围栏）。 */
export function parsePatch(text) {
  const s = String(text || "").trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "输出里找不到 JSON" };
  try {
    const j = JSON.parse(body.slice(start, end + 1));
    if (!j || typeof j !== "object") return { error: "JSON 不是对象" };
    return { ok: true, files: Array.isArray(j.files) ? j.files : [], edits: Array.isArray(j.edits) ? j.edits : [], note: String(j.note || "") };
  } catch (e) {
    return { error: `JSON 解析失败：${String(e.message).slice(0, 80)}` };
  }
}

/**
 * 校验补丁：范围、数量、体积、路径安全。任何一条不过就整体拒绝（不做部分应用）。
 */
export function validatePatch(repoRoot, plan, patch) {
  const allowed = allowedFromPlan(plan);
  const files = patch?.files || [];
  const edits = patch?.edits || [];
  if (!files.length && !edits.length) return { ok: false, error: patch?.note ? `生成器放弃：${patch.note}` : "生成器没有产出文件" };
  if (edits.length) {
    if (edits.length > MAX_EDITS) return { ok: false, error: `改动点太多（${edits.length} > ${MAX_EDITS}）` };
    const checked = [];
    for (const e of edits) {
      const rel = String(e?.path || "").replace(/\\/g, "/");
      const v = assertAllowed(repoRoot, rel, allowed);
      if (!v.ok) return { ok: false, error: v.error };
      const find = String(e?.find ?? "");
      const replace = String(e?.replace ?? "");
      if (!find.trim()) return { ok: false, error: `${rel} 的 find 为空` };
      if (Buffer.byteLength(find + replace, "utf8") > MAX_EDIT_BYTES) return { ok: false, error: `${rel} 的单处改动超过 ${MAX_EDIT_BYTES} 字节` };
      const abs = path.join(repoRoot, v.rel);
      if (!fs.existsSync(abs)) return { ok: false, error: `${v.rel} 不存在（定点补丁只能改已有文件）` };
      const cur = fs.readFileSync(abs, "utf8");
      const hit = compatFind(cur, find);
      if (hit.index < 0) return { ok: false, error: `${v.rel} 里找不到 find（可能被改过或缩进不符）` };
      if (cur.indexOf(hit.find, hit.index + 1) >= 0) return { ok: false, error: `${v.rel} 的 find 出现多次，不唯一，拒绝（避免改错地方）` };
      // replace 也统一成文件实际用的行尾
      const eol = cur.includes("\r\n") ? "\r\n" : "\n";
      const fixedReplace = String(replace).replace(/\r?\n/g, eol);
      checked.push({ path: v.rel, find: hit.find, replace: fixedReplace });
    }
    return { ok: true, files: [], edits: checked, note: String(patch?.note || "") };
  }
  if (files.length > MAX_FILES) return { ok: false, error: `文件太多（${files.length} > ${MAX_FILES}）` };
  const out = [];
  for (const f of files) {
    const p = String(f?.path || "").replace(/\\/g, "/");
    if (!p) return { ok: false, error: "有文件缺少 path" };
    const v = assertAllowed(repoRoot, p, allowed);
    if (!v.ok) return { ok: false, error: v.error };
    const content = String(f?.content ?? "");
    if (!content.trim()) return { ok: false, error: `${p} 内容为空` };
    if (Buffer.byteLength(content, "utf8") > MAX_BYTES) return { ok: false, error: `${p} 超过 ${MAX_BYTES} 字节` };
    out.push({ path: v.rel, content });
  }
  return { ok: true, files: out, note: String(patch?.note || "") };
}

/**
 * 默认生成器：走本机 **单次补全** /api/engine/chat（tools:false）。
 *
 * 2026-10-26 真机教训：第一版用 /api/chat，那是**完整 agent 回合**——它会调工具、
 * 可能自己去写文件，8 分钟都没返回（超时）。生成补丁只需要一次纯文本补全，
 * 不要给它工具、不要给它会话上下文。
 */
export function makeHttpGenerator({ baseUrl = "http://127.0.0.1:8787", token, fetch: f = globalThis.fetch } = {}) {
  return async function generate(plan, { repoRoot } = {}) {
    const ctx = repoRoot ? collectContext(repoRoot, plan) : [];
    const res = await f(`${baseUrl}/api/engine/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        message: buildPrompt(plan, ctx),
        tools: false,
        system: "你是一个只输出 JSON 的补丁生成器。不要解释、不要 Markdown 围栏、不要调用任何工具。",
        params: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    const j = await res.json().catch(() => ({}));
    const text = String(j.text || j.content || "");
    if (!text) return { files: [], note: `模型没有返回文本（HTTP ${res.status}）` };
    const parsed = parsePatch(text);
    // 2026-10-26 真机：这里原来只返回 files，定点补丁（edits）被丢光，
    // 于是服务端一直报「生成器没有产出文件」，而模型其实给了 3 处精确编辑。
    return parsed.ok ? { files: parsed.files, edits: parsed.edits || [], note: parsed.note } : { files: [], edits: [], note: parsed.error };
  };
}

/** 备用生成器：把提示词交给外部 CLI（YUANSHU_PATCH_CMD 里用 {prompt} 占位）。 */
export function makeCmdGenerator(template) {
  return async function generate(plan) {
    const prompt = buildPrompt(plan);
    const cmd = String(template).replace("{prompt}", prompt.replace(/"/g, '\\"'));
    const r = spawnSync(process.platform === "win32" ? "cmd" : "sh", [process.platform === "win32" ? "/c" : "-c", cmd],
      { encoding: "utf8", timeout: 600000, windowsHide: true });
    const parsed = parsePatch(`${r.stdout || ""}${r.stderr || ""}`);
    return parsed.ok ? { files: parsed.files, edits: parsed.edits || [], note: parsed.note } : { files: [], edits: [], note: parsed.error || "CLI 没有输出" };
  };
}

/** 一个什么都不做的生成器：没配生成器时用它，让管道如实报告"缺生成器"而不是假装干活。 */
export function makeNullGenerator() {
  return async () => ({ files: [], note: "没有可用的生成器（设 YUANSHU_PATCH_CMD 或走 http）" });
}

export function pickGenerator({ token, env = process.env } = {}) {
  if (env.YUANSHU_PATCH_CMD) return { kind: "cmd", generate: makeCmdGenerator(env.YUANSHU_PATCH_CMD) };
  if (env.YUANSHU_PATCH_GENERATOR === "none") return { kind: "none", generate: makeNullGenerator() };
  if (token) return { kind: "http", generate: makeHttpGenerator({ token }) };
  return { kind: "none", generate: makeNullGenerator() };
}
