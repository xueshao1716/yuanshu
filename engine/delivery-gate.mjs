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
    if (row.ok === false) failures.push({ at, tool: String(before?.tool || tool || ""), error: String(row.error || "").slice(0, 160) });
    if (VERIFY_CMD.test(command)) verifications.push({ at, command: command.slice(0, 120), ok: row.ok !== false });
  }
  return { changes, verifications, failures };
}

/**
 * 判定交付。纯函数，好测。
 * @param {{rows?: any[], changedFiles?: string[], blockers?: string[], verified?: string[]}} input
 * @returns {{verdict:'GREEN'|'YELLOW'|'RED', covered:string[], uncovered:string[], failedChecks:any[], reasons:string[], conditions:string[]}}
 */
export function judgeDelivery({ rows = [], changedFiles = [], blockers = [], verified = [] } = {}) {
  const { changes, verifications, failures } = extractEvidence(rows);
  // 显式给出的改动（比如调用方自己有清单）也要算
  for (const f of changedFiles) if (f && !changes.has(f)) changes.set(f, 0);
  // 显式声明的已验证文件：把它当成"有证据"，但要写进 conditions 里提醒
  const declared = new Set(verified.map((x) => String(x)));

  const covered = [];
  const uncovered = [];
  for (const [file, changedAt] of changes) {
    const ok = verifications.some((v) => v.ok && v.at > changedAt);
    if (ok || declared.has(file)) covered.push(file);
    else uncovered.push(file);
  }

  const failedChecks = failures.filter((f) => f.tool === "bash" || f.tool === "run_code");
  const failingVerify = verifications.filter((v) => !v.ok);
  const reasons = [];
  const conditions = [];

  if (failedChecks.length) reasons.push(`${failedChecks.length} 次命令执行失败`);
  if (failingVerify.length) reasons.push(`${failingVerify.length} 次验证没通过`);
  if (uncovered.length) reasons.push(`${uncovered.length} 个改动文件没被验证覆盖`);
  if (declared.size) conditions.push("部分文件是「声明已验证」，没有验证记录");

  let verdict = "GREEN";
  if (reasons.length) verdict = "RED";
  else if (blockers.length || conditions.length) verdict = "YELLOW";
  for (const b of blockers) conditions.push(String(b));

  return { verdict, covered: dedupePaths(covered), uncovered: dedupePaths(uncovered), failedChecks, failingVerify, reasons, conditions };
}

/** 结果落一行可读结论，给通知/事务台用。 */
export function describeVerdict(result) {
  const v = result?.verdict || "RED";
  if (v === "GREEN") return "改动都有验证覆盖，可以交付";
  if (v === "YELLOW") return `可以交付，但有条件：${(result.conditions || []).join("；") || "外部阻塞"}`;
  const parts = [...(result.reasons || [])];
  if (result.uncovered?.length) parts.push(`未覆盖：${result.uncovered.slice(0, 3).join("、")}`);
  return `不能交付：${parts.join("；")}`;
}

/** 最近一次判定（按 runId 过滤），供接口用。 */
export function judgeRun({ rows = [], runId = "", changedFiles = [], verified = [] } = {}) {
  const scoped = runId ? rows.filter((r) => String(r.runId || "") === String(runId)) : rows;
  return judgeDelivery({ rows: scoped, changedFiles, verified });
}
