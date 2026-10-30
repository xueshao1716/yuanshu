// ===== initiator.mjs —— 这次动作是谁发起的（2026-10-30）=====
//
// OpenBot 的 `initiator.*` 维度：同一条规则可以放行「人让做的」，拦住「定时任务自己发起的」。
// 元枢现在定时任务越来越多（简报 / 做梦 / 自动补丁），必须能区分"谁让它干的"。
//
// 用 AsyncLocalStorage：不靠全局变量，并发跑也不会串。
import { AsyncLocalStorage } from "node:async_hooks";

export const KINDS = ["user", "scheduler", "agent", "subagent"];

const als = new AsyncLocalStorage();

export function currentInitiator() {
  return als.getStore()?.kind || "user";
}

/** 在指定发起者上下文里跑一段（默认 user）。 */
export function runWithInitiator(kind, fn) {
  const k = KINDS.includes(kind) ? kind : "user";
  return als.run({ kind: k, at: Date.now() }, fn);
}

/** 给异步函数包一层，调用时自动切上下文。 */
export function asInitiator(kind, fn) {
  return (...args) => runWithInitiator(kind, () => fn(...args));
}

/**
 * 极简 glob：双星跨目录，单星不跨目录，问号单字符。够表达 任意目录下的 .env、记忆/人格定义.json 这类。
 */
export function globMatch(pattern, target) {
  const p = String(pattern || "").replace(/\\/g, "/");
  const t = String(target || "").replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") { re += ".*"; i += 1; continue }
    if (c === "*") { re += "[^/]*"; continue }
    if (c === "?") { re += "."; continue }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const hit = (() => { try { return new RegExp("^" + re + "$").test(t) } catch { return false } })();
  if (hit) return true;
  // 2026-10-30：双星开头时也允许没有前缀 —— 裸的 .env 也该被 **/.env 命中
  return p.startsWith("**/") ? globMatch(p.slice(3), t) : false;
}

/**
 * 策略判定（纯函数，好测）：
 *   rules: [{ id, initiator: ["scheduler"], deny: ["bash:(rm|del)", "notify_user"], reason }]
 * 规则按顺序判，命中即拒（deny 永远赢）；没有规则命中就放行。
 */
export function judgeAction({ tool = "", args = "", initiator = "user", rules = [] } = {}) {
  const t = String(tool || "");
  const a = typeof args === "string" ? args : JSON.stringify(args || {});
  for (const rule of rules || []) {
    const kinds = Array.isArray(rule?.initiator) ? rule.initiator : null;
    if (kinds && !kinds.includes(initiator)) continue;
    for (const pat of rule.deny || []) {
      const m = String(pat).match(/^([^:]+):(.*)$/);
      const toolPat = m ? m[1] : String(pat);
      const argPat = m ? m[2] : "";
      if (!new RegExp(`^${toolPat}$`, "i").test(t)) continue;
      if (argPat && !new RegExp(argPat, "i").test(a)) continue;
      // 2026-10-30：可选路径条件（比正则好写）。只对带 path 的工具生效。
      if (Array.isArray(rule.paths) && rule.paths.length) {
        let path = "";
        try { const o = typeof args === "string" ? JSON.parse(args) : (args || {}); path = String(o.path || o.file || o.target || "") } catch {}
        if (!path || !rule.paths.some((g) => globMatch(g, path))) continue;
      }
      return { allow: false, ruleId: String(rule.id || "rule"), reason: String(rule.reason || "被策略拒绝") };
    }
  }
  return { allow: true, ruleId: "" };
}

/** 默认策略：定时任务不许自己删东西、不许自己对外发消息。 */
export const DEFAULT_RULES = [
  { id: "no-scheduler-destructive", initiator: ["scheduler"], deny: ["bash:(rm\\s|del\\s|format|rmdir|Remove-Item|shred)"], reason: "定时任务不许自己删东西" },
  { id: "no-scheduler-external", initiator: ["scheduler"], deny: ["notify_user", "run_detached"], reason: "定时任务不许自己对外发消息/拉长活" },
];
