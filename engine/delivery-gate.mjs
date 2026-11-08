// ===== delivery-gate.mjs —— 交付门：没有证据，不算完成（2026-10-31）=====
//
// 来源：天枢 Harness 的 deliver_task —— 说"完成"之前，先检查本轮改过的每个文件
// 有没有被验证覆盖，给 GREEN / YELLOW / RED。
//
// 元枢的病：她说"已修复/已验证"，但我们没有机制检查这句话。
// 现有材料是够的：动作审计（engine/tools/audit-gate.mjs）记了每次工具调用和结果，
// 只要把「改动」和「验证」从审计行里认出来，再做时间顺序判定即可。
//
// 判定语义（顺序很重要）：
//   · 改动 = 最后一次写某个文件的时间
//   · 覆盖 = 有一个验证动作发生在这次改动**之后**
//   · 失败项 → RED；有文件没被覆盖 → RED；只有外部阻塞 → YELLOW；全部覆盖 → GREEN
import path from "node:path";

export const CHANGE_TOOLS = new Set(["write", "edit", "apply_patch", "patch", "multiedit", "notebook_edit", "str_replace_editor"]);
// 脚本里跑测试时命令本身看不到关键字（如 node scripts/run-tests.mjs），但输出里会有结果行
export const VERIFY_OUTPUT = /(\d+\s*(passed|passing|个?测试通过)|\bPASS\b|\bok\s*\d+|0\s*fail|tests?\s+\d+.*\bpass|全部通过|用例通过|通过\s*\d+)/i;
const VERIFY_CMD = /(npm\s+(run\s+)?(test|build|lint|check)|node\s+--test|node\s+--check|pytest|vitest|jest|tsc\b|go\s+test|cargo\s+(test|check)|评测|跑分|bench)/i;

/** 从审计行的 argsPreview 里抠路径（预览被截断到 80 字，所以用正则而不是 JSON.parse）。 */
export function pathOfRow(row) {
  const preview = String(row?.argsPreview || "");
  const m = preview.match(/"path"\s*:\s*"([^"]+)"/) || preview.match(/"file"\s*:\s*"([^"]+)"/);
  return m ? m[1] : "";
}

/** 同一个文件的相对/绝对写法合并成一个（保留更长的那条，通常是绝对路径）。 */
export function dedupePaths(files = []) {
  const norm = (x) => String(x || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const out = [];
  for (const f of files) {
    const n = norm(f);
    if (!n) continue;
    const dup = out.findIndex((k) => {
      const a = norm(k).toLowerCase(), b = n.toLowerCase();
      return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
    });
    if (dup < 0) out.push(String(f));
    else if (n.length > norm(out[dup]).length) out[dup] = String(f);
  }
  return out;
}

/** 审计行 → {changes, verifications, failures}。 */
export function extractEvidence(rows = []) {
  const changes = new Map();   // file -> lastAt
  const verifications = [];    // {at, command, ok}
  const failures = [];         // {at, tool, error}
  const pending = new Map();   // argsHash -> {tool, preview, at}（after 行没有参数，要回查）
  const lastByTool = new Map(); // tool -> preview（老审计行没有 argsHash 时的兜底）

  for (const row of rows) {
    const at = Number(row?.at) || 0;
    const tool = String(row?.tool || "");
    const hash = String(row?.argsHash || "");
    if (row?.phase === "before") {
      const preview = String(row?.argsPreview || "");
      if (hash) pending.set(hash, { tool, preview, at });
      if (tool) lastByTool.set(tool, preview);
      if (CHANGE_TOOLS.has(tool)) {
        const file = pathOfRow(row);
        if (file) changes.set(file, Math.max(changes.get(file) || 0, at));
      }
      continue;
    }
    if (row?.phase !== "after") continue;
    const before = (hash ? pending.get(hash) : null) || { tool, preview: lastByTool.get(tool) || "" };
    const preview = String(before?.preview || row?.argsPreview || "");
    const command = preview.match(/"command"\s*:\s*"([^"]*)"/)?.[1] || "";
    if (row.ok === false) failures.push({
      at,
      tool: String(before?.tool || tool || ""),
      error: String(row.error || "").slice(0, 160),
      // 2026-11-08：RED 要说清"卡在哪条命令、报了什么"，所以把命令与输出摘要一起留下。
      command: String(command || "").slice(0, 160),
      output: String(row.resultPreview || row.error || "").slice(0, 240),
    });
    const output = String(row?.resultPreview || "");
    const looksLikeVerify = VERIFY_CMD.test(command) || VERIFY_OUTPUT.test(output);
    if (looksLikeVerify) verifications.push({ at, command: (command || output).slice(0, 120), ok: row.ok !== false, viaOutput: !VERIFY_CMD.test(command) });
  }
  return { changes, verifications, failures };
}

/** 把多行输出压成一行可读摘要（日志/通知里不能换行）。 */
const oneLine = (value, max = 0) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return max > 0 ? s.slice(0, max) : s;
};

/**
 * RED 的结构化失败项（2026-11-08）。
 *
 * 事故现场只有一句「不能交付：13 次命令执行失败；8 个改动文件没被验证覆盖」——
 * 看不到到底是哪条命令、报了什么、没覆盖的是哪些文件。这里把失败命令与未覆盖文件
 * 整理成**可直接展示**的字段：失败数、前 3 条命令及输出摘要（各 ≤120 字）、未覆盖总数。
 */
export function summarizeFailures({ failedChecks = [], uncovered = [] } = {}) {
  const commands = (Array.isArray(failedChecks) ? failedChecks : []).slice(0, 3).map((f) => ({
    command: oneLine(f?.command || f?.tool || "命令", 100),
    output: oneLine(f?.output || f?.error || "（无输出）", 120),
  }));
  const files = Array.isArray(uncovered) ? uncovered : [];
  return { failedCount: Array.isArray(failedChecks) ? failedChecks.length : 0, failedCommands: commands, uncoveredTotal: files.length };
}

/**
 * 判定交付。纯函数，好测。
 * @param {{rows?: any[], changedFiles?: string[], blockers?: string[], verified?: string[]}} input
 * @returns {{verdict:'GREEN'|'YELLOW'|'RED', covered:string[], uncovered:string[], failedChecks:any[], reasons:string[], conditions:string[]}}
 */
export function judgeDelivery({ rows = [], changedFiles = [], blockers = [], verified = [], strictness = "normal" } = {}) {
  // 2026-11-01：strictness 由脑区 verification 权重决定；
  // strict = 声明已验证不算覆盖，loose = 声明即视为覆盖。
  const declareCounts = strictness !== "strict";
  const { changes, verifications, failures } = extractEvidence(rows);
  // 显式给出的改动（比如调用方自己有清单）也要算
  for (const f of changedFiles) if (f && !changes.has(f)) changes.set(f, 0);
  // 显式声明的已验证文件：把它当成"有证据"，但要写进 conditions 里提醒
  const declared = new Set(verified.map((x) => String(x)));

  const covered = [];
  const uncovered = [];
  for (const [file, changedAt] of changes) {
    const ok = verifications.some((v) => v.ok && v.at > changedAt);
    if (ok || (declareCounts && declared.has(file))) covered.push(file);
    else uncovered.push(file);
  }

  const failedChecks = failures.filter((f) => f.tool === "bash" || f.tool === "run_code");
  const failingVerify = verifications.filter((v) => !v.ok);
  const uncoveredList = dedupePaths(uncovered);
  const structured = summarizeFailures({ failedChecks, uncovered: uncoveredList });
  const reasons = [];
  const conditions = [];

  if (failedChecks.length) reasons.push(`${failedChecks.length} 次命令执行失败`);
  if (failingVerify.length) reasons.push(`${failingVerify.length} 次验证没通过`);
  if (uncoveredList.length) reasons.push(`${uncoveredList.length} 个改动文件没被验证覆盖`);
  if (declared.size && declareCounts) conditions.push("部分文件是「声明已验证」，没有验证记录");

  let verdict = "GREEN";
  if (reasons.length) verdict = "RED";
  else if (blockers.length || conditions.length) verdict = strictness === "loose" ? "GREEN" : "YELLOW";
  for (const b of blockers) conditions.push(String(b));

  return {
    verdict,
    covered: dedupePaths(covered),
    uncovered: uncoveredList,
    uncoveredTotal: structured.uncoveredTotal,
    failedChecks,
    failedCount: structured.failedCount,
    failedCommands: structured.failedCommands,
    failingVerify,
    reasons,
    conditions,
  };
}

/**
 * 结果落成可读结论（通知/事务台/工具回话用）。
 *
 * 2026-11-08：RED 不再是一句「不能交付」。要把失败项结构化带出来：
 * 失败命令数 + 前 3 条命令及输出摘要（各 ≤120 字）+ 未覆盖文件（前 5 + 总数）。
 * 第一行仍是「不能交付：…」，日志与既有读者不受影响；细节在后续行。
 */
export function describeVerdict(result) {
  const v = result?.verdict || "RED";
  if (v === "GREEN") return "改动都有验证覆盖，可以交付";
  if (v === "YELLOW") return `可以交付，但有条件：${(result.conditions || []).join("；") || "外部阻塞"}`;
  const parts = [...(result.reasons || [])];
  const lines = [`不能交付：${parts.join("；") || "证据不足"}`];
  const failed = Array.isArray(result.failedCommands) ? result.failedCommands : [];
  if (failed.length) {
    const total = Number(result.failedCount) || failed.length;
    lines.push(`失败命令（共 ${total} 次，前 ${failed.length} 条）：`);
    failed.slice(0, 3).forEach((f, i) => {
      const cmd = oneLine(f?.command || f?.tool || "命令", 100);
      const out = oneLine(f?.output || f?.error || "（无输出）", 120);
      lines.push(`${i + 1}. ${cmd} → ${out}`);
    });
  }
  const uncovered = Array.isArray(result.uncovered) ? result.uncovered : [];
  if (uncovered.length) {
    const total = Number(result.uncoveredTotal) || uncovered.length;
    lines.push(`未覆盖文件（共 ${total} 个，前 ${Math.min(5, uncovered.length)} 个）：${uncovered.slice(0, 5).join("、")}`);
  }
  return lines.join("\n");
}

/** 最近一次判定（按 runId 过滤），供接口用。 */
export function judgeRun({ rows = [], runId = "", changedFiles = [], verified = [] } = {}) {
  const scoped = runId ? rows.filter((r) => String(r.runId || "") === String(runId)) : rows;
  return judgeDelivery({ rows: scoped, changedFiles, verified });
}
