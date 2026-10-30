// ===== audit-gate.mjs —— 先记账，再执行（2026-10-30）=====
//
// 来源：OpenBot 的设计「没有任何一条路径可以在记录不存在的情况下行动」。
// 元枢现在有 deny 规则、只读白名单、审批 seam，但**没有统一的一行"动作记录"**：
// 工具调用发生就发生了，事后查不到"她当时想做什么、参数是什么、结果如何"。
//
// 这里做最小可信版本：
//   · 每次工具调用前先落一行 {at, tool, argsHash, session}，写成功才执行
//   · 执行后补一行结果（ok/error/耗时）
//   · 写不进去就**拒绝执行**（fail-closed），除非显式 YUANSHU_AUDIT_SOFT=1
//   · 参数只记 hash 和前 80 字（避免把令牌/密码写进审计）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { currentInitiator, judgeAction } from "./initiator.mjs";

export const AUDIT_REL = path.join("记忆", "运行时", "动作审计.jsonl");

export function auditPath(wsRoot) {
  return path.join(String(wsRoot || "."), AUDIT_REL);
}

/** 参数摘要：只留 hash + 可读前缀，避免凭据落盘。 */
export function summarizeArgs(args) {
  const raw = typeof args === "string" ? args : JSON.stringify(args || {});
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const preview = raw.replace(/("(?:token|key|secret|password|authorization)"\s*:\s*)"[^"]*"/gi, "$1\"***\"")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "***")
    .slice(0, 80);
  return { hash, preview, bytes: raw.length };
}

export function createAuditGate({ wsRoot = ".", file = "", now = Date.now, soft = process.env.YUANSHU_AUDIT_SOFT === "1" } = {}) {
  const target = file || auditPath(wsRoot);
  const append = (row) => {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, JSON.stringify(row) + "\n", "utf8");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 120) };
    }
  };

  return {
    /** 动作开始：写成功才允许执行。 */
    before({ tool = "", args = {}, session = "", runId = "", initiator = "", rules = [] } = {}) {
      const s = summarizeArgs(args);
      const who = initiator || currentInitiator();
      // 2026-10-30：先判"谁让它干的"。定时任务不许干的（删东西/对外发），人让做就放行。
      const verdict = judgeAction({ tool, args, initiator: who, rules });
      const base = { at: now(), tool: String(tool).slice(0, 64), session: String(session).slice(0, 64), runId: String(runId).slice(0, 64), initiator: who, argsHash: s.hash, argsPreview: s.preview, argsBytes: s.bytes };
      if (!verdict.allow) {
        append({ ...base, phase: "denied", ruleId: verdict.ruleId, reason: verdict.reason });
        return { ok: false, denied: true, ruleId: verdict.ruleId, error: `被策略拒绝（${verdict.ruleId}）：${verdict.reason}` };
      }
      const r = append({ ...base, phase: "before" });
      if (r.ok || soft) return { ok: true, id: s.hash, initiator: who, softSkipped: !r.ok };
      return { ok: false, error: `审计写不进去，拒绝执行：${r.error}` };
    },
    /** 动作结束：补一行结果。失败不阻断（已经执行了）。 */
    after({ tool = "", argsHash = "", ok = true, ms = 0, error = "" } = {}) {
      append({ at: now(), phase: "after", tool: String(tool).slice(0, 64), argsHash: String(argsHash).slice(0, 32), ok: !!ok, ms: Number(ms) || 0, error: String(error).slice(0, 200) });
    },
    tail(limit = 20) {
      try {
        const lines = fs.readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean).slice(-Math.max(1, limit));
        return lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
      } catch { return [] }
    },
  };
}

/** 用闸门包一层工具执行器：每次调用都先记账。 */
export function withAuditGate(execute, { gate, rules = [], sessionOf = (ctx) => ctx?.sessionId || ctx?.sessionKey || "" } = {}) {
  if (typeof execute !== "function" || !gate) return execute;
  return async function audited(name, args, ctx) {
    const started = Date.now();
    const begin = gate.before({ tool: name, args, session: sessionOf(ctx), runId: ctx?.runId || "", rules });
    if (!begin.ok) return { text: `⛔ ${begin.error}`, isError: true, denied: !!begin.denied, ruleId: begin.ruleId || "" };
    try {
      const r = await execute(name, args, ctx);
      gate.after({ tool: name, argsHash: begin.id, ok: !r?.isError, ms: Date.now() - started, error: r?.isError ? String(r?.text || "").slice(0, 160) : "" });
      return r;
    } catch (e) {
      gate.after({ tool: name, argsHash: begin.id, ok: false, ms: Date.now() - started, error: String(e?.message || e).slice(0, 160) });
      throw e;
    }
  };
}
