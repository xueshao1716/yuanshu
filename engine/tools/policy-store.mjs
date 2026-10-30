// ===== policy-store.mjs —— 动作策略落到文件里，可改可查可回滚（2026-10-30）=====
//
// 为什么：策略以前写死在 DEFAULT_RULES 里。规则是"谁能干什么"的边界，
// 边界必须能被看见、被修改、被追责——写死在代码里，用户只能找我改。
//
// 文件：记忆/运行时/动作策略.json
//   { v: 1, updatedAt, rules: [{ id, initiator: [...], deny: [...], reason }], history: [...] }
// 首次读取会把默认规则播种进去（用户能直接编辑）。
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RULES, KINDS } from "./initiator.mjs";

export const POLICY_REL = path.join("记忆", "运行时", "动作策略.json");

export function policyPath(wsRoot) {
  return path.join(String(wsRoot || "."), POLICY_REL);
}

/** 校验一组规则：id 必填且唯一、initiator 合法、deny 非空。 */
export function validateRules(rules) {
  if (!Array.isArray(rules)) return { ok: false, error: "rules 必须是数组" };
  const seen = new Set();
  for (const [i, r] of rules.entries()) {
    if (!r || typeof r !== "object") return { ok: false, error: `第 ${i + 1} 条不是对象` };
    const id = String(r.id || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) return { ok: false, error: `第 ${i + 1} 条 id 不合法` };
    if (seen.has(id)) return { ok: false, error: `id 重复：${id}` };
    seen.add(id);
    if (!Array.isArray(r.deny) || !r.deny.length) return { ok: false, error: `${id}：deny 不能为空` };
    if (r.paths !== undefined && (!Array.isArray(r.paths) || !r.paths.length)) return { ok: false, error: `${id}：paths 必须是非空数组` };
    if (r.initiator !== undefined) {
      if (!Array.isArray(r.initiator)) return { ok: false, error: `${id}：initiator 必须是数组` };
      const bad = r.initiator.find((k) => !KINDS.includes(String(k)));
      if (bad) return { ok: false, error: `${id}：initiator 里 ${bad} 不是合法身份（${KINDS.join("/")}）` };
    }
  }
  return { ok: true, rules: rules.map((r) => ({ id: String(r.id), initiator: r.initiator ? r.initiator.map(String) : undefined, deny: r.deny.map(String), paths: Array.isArray(r.paths) ? r.paths.map(String) : undefined, reason: String(r.reason || "") })) };
}

/** 读策略；文件不存在就播种默认规则。返回 {v, rules, source, updatedAt, error?} */
export function readPolicy(wsRoot, { seed = true } = {}) {
  const file = policyPath(wsRoot);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const v = validateRules(raw?.rules);
    if (!v.ok) return { v: 1, rules: DEFAULT_RULES, source: "default", error: `策略文件不合法（${v.error}），暂用默认规则`, updatedAt: raw?.updatedAt || 0 };
    return { v: 1, rules: v.rules, source: "file", updatedAt: Number(raw?.updatedAt) || 0, history: Array.isArray(raw?.history) ? raw.history.slice(-5) : [] };
  } catch (e) {
    if (e?.code === "ENOENT") {
      if (seed) { try { writePolicy(wsRoot, DEFAULT_RULES, { seed: true }) } catch {} }
      return { v: 1, rules: DEFAULT_RULES, source: "seeded", updatedAt: 0 };
    }
    return { v: 1, rules: DEFAULT_RULES, source: "default", error: `读不到策略文件（${String(e?.message || e).slice(0, 60)}），暂用默认规则` };
  }
}

/** 写策略：校验 → 备份上一条进 history → 落盘。 */
export function writePolicy(wsRoot, rules, { now = Date.now(), seed = false } = {}) {
  const v = validateRules(rules);
  if (!v.ok) return { ok: false, error: v.error };
  const file = policyPath(wsRoot);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
  const snap = prev && !seed
    ? [{ id: `snap-${Number(prev?.updatedAt) || 0}`, at: Number(prev?.updatedAt) || 0, rules: (prev?.rules || []).slice(0, 40) }]
    : [];
  const history = [...(prev?.history || []), ...snap].slice(-5);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, updatedAt: now, rules: v.rules, history }, null, 2), "utf8");
    return { ok: true, rules: v.rules, updatedAt: now, historyCount: history.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

/** 回滚到某个历史快照（快照 id 或 at 时间戳）。回滚本身也会被记进历史。 */
export function rollbackPolicy(wsRoot, key, { now = Date.now() } = {}) {
  const file = policyPath(wsRoot);
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return { ok: false, error: "读不到策略文件" } }
  const history = Array.isArray(raw?.history) ? raw.history : [];
  if (!history.length) return { ok: false, error: "没有可回滚的历史" };
  const hit = history.find((h) => String(h?.id) === String(key)) || history.find((h) => Number(h?.at) === Number(key));
  if (!hit) return { ok: false, error: "找不到这个快照" };
  const out = writePolicy(wsRoot, hit.rules || [], { now });
  return out.ok ? { ok: true, rolledBackTo: hit.id || hit.at, ...out } : out;
}

/** 带缓存的读取器：每次工具调用都读文件太浪费，按 mtime 判缓存。 */
export function createPolicyProvider({ wsRoot, ttlMs = 2000, now = Date.now } = {}) {
  let cache = { at: 0, rules: null, source: "", error: "" };
  return {
    rules() {
      const t = now();
      if (cache.rules && t - cache.at < ttlMs) return cache.rules;
      const p = readPolicy(wsRoot);
      cache = { at: t, rules: p.rules, source: p.source, error: p.error || "" };
      return p.rules;
    },
    status() {
      const p = readPolicy(wsRoot);
      return { rules: p.rules, source: p.source, updatedAt: p.updatedAt, error: p.error || "", path: policyPath(wsRoot) };
    },
  };
}
