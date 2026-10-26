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
export const MAX_BYTES = 20_000;

/** 提示词：只让它产出 JSON，不给自由发挥空间。 */
export function buildPrompt(plan = {}) {
  return [
    "你在为一个自动化补丁管道写代码。严格按下面的计划改，只改计划里列出的文件。",
    "",
    `问题：${plan.title || ""}`,
    `症状：${plan.symptom || ""}`,
    plan.evidence?.length ? `证据：\n${plan.evidence.join("\n")}` : "",
    `允许改动的文件：${(plan.files || []).join(", ")}`,
    `验收标准：${plan.accept || ""}`,
    "",
    "要求：",
    "1. 只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码围栏。",
    '2. 格式：{"files":[{"path":"相对仓库根的路径","content":"完整文件内容"}],"note":"一句话说明改了什么"}',
    "3. content 必须是**完整文件内容**（不是 diff），我会整文件替换。",
    `4. 最多 ${MAX_FILES} 个文件，每个不超过 ${MAX_BYTES} 字节。`,
    "5. 如果无法在计划范围内解决问题，输出 {\"files\":[],\"note\":\"原因\"}。",
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
    return { ok: true, files: Array.isArray(j.files) ? j.files : [], note: String(j.note || "") };
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
  if (!files.length) return { ok: false, error: patch?.note ? `生成器放弃：${patch.note}` : "生成器没有产出文件" };
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

/** 默认生成器：走本机 /api/chat（元枢自己）。 */
export function makeHttpGenerator({ baseUrl = "http://127.0.0.1:8787", token, fetch: f = globalThis.fetch } = {}) {
  return async function generate(plan) {
    const mk = await f(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ title: `[自动补丁] ${String(plan.title || "").slice(0, 40)}` }),
    });
    const sid = (await mk.json())?.id;
    if (!sid) return { files: [], note: "建会话失败" };
    const res = await f(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ sessionId: sid, message: buildPrompt(plan), noTools: true }),
    });
    const raw = await res.text();
    // SSE 里把 delta 拼起来
    const text = raw.includes("\"text\"")
      ? [...raw.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map((m) => { try { return JSON.parse(`"${m[1]}"`) } catch { return "" } }).join("")
      : raw;
    const parsed = parsePatch(text);
    return parsed.ok ? { files: parsed.files, note: parsed.note } : { files: [], note: parsed.error };
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
    return parsed.ok ? { files: parsed.files, note: parsed.note } : { files: [], note: parsed.error || "CLI 没有输出" };
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
