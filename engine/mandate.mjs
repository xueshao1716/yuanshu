// ===== mandate.mjs —— 工单级授权（2026-11-07）=====
//
// 借 dsh-superagent 的 Mandate：授权不是一句全局的「你能干什么」，而是**跟着这张活走**，
// 记清依据、期限与失效条件；人一句「停」就撤回，恢复前要重验。
//
// 元枢现状是「全局行动权清单（提示词级）+ 单次审批 + 花钱三档预算」，中间缺这一层。
// 本模块只做记录与判定，不接管审批链路——先让授权可追溯，再谈强制。
import fs from "node:fs";
import path from "node:path";

export const MANDATE_REL = path.join("记忆", "运行时", "工单授权.json");
export const DEFAULT_TTL_HOURS = 24;
// 默认永远不授权的动作：对外发布、合并、花钱、改人格/宪法
export const ALWAYS_DENIED = Object.freeze(["publish", "merge", "spend", "persona", "constitution", "tunnel"]);

export function mandateFile(wsRoot) {
  return path.join(String(wsRoot || "."), MANDATE_REL);
}

function readAll(wsRoot) {
  try {
    const d = JSON.parse(fs.readFileSync(mandateFile(wsRoot), "utf8"));
    return { version: Number(d?.version) || 1, items: Array.isArray(d?.items) ? d.items : [] };
  } catch { return { version: 1, items: [] } }
}

function writeAll(wsRoot, doc) {
  try {
    fs.mkdirSync(path.dirname(mandateFile(wsRoot)), { recursive: true });
    fs.writeFileSync(mandateFile(wsRoot), JSON.stringify(doc, null, 2), "utf8");
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 160) } }
}

/**
 * 开一张授权。basis 记「凭什么给的」：explicit（人直接要求）/ rule（命中了哪条规则）/ inherited。
 * @returns {{ ok:boolean, mandate?:object, error?:string }}
 */
export function createMandate(wsRoot, {
  ticketId, threadKey = "", taskId = "", scope = [], basis = "explicit",
  policyVersion = 1, ttlHours = DEFAULT_TTL_HOURS, now = Date.now(), note = "",
} = {}) {
  const id = String(ticketId || "").trim();
  if (!id) return { ok: false, error: "缺少 ticketId" };
  const doc = readAll(wsRoot);
  const exist = doc.items.find((x) => x.ticketId === id && !x.revokedAt && !x.closedAt);
  if (exist) return { ok: true, mandate: exist };
  const mandate = {
    ticketId: id,
    threadKey: String(threadKey || ""),
    taskId: String(taskId || ""),
    scope: [...new Set((Array.isArray(scope) ? scope : []).map(String))].filter(Boolean),
    basis: String(basis || "explicit"),
    policyVersion: Number(policyVersion) || 1,
    note: String(note || "").slice(0, 200),
    createdAt: now,
    expiresAt: now + Math.max(1, Number(ttlHours) || DEFAULT_TTL_HOURS) * 3600 * 1000,
    revokedAt: 0,
    closedAt: 0,
    outcome: "",
  };
  doc.items.push(mandate);
  const w = writeAll(wsRoot, doc);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, mandate };
}

/** 全部记录（含已结束/已撤销），给「授权中心」回看用。 */
export function listMandates(wsRoot) {
  return readAll(wsRoot).items;
}
/** 当前有效（未撤销、未关闭、未过期）的授权。 */
export function activeMandates(wsRoot, { now = Date.now() } = {}) {
  return readAll(wsRoot).items.filter((m) => !m.revokedAt && !m.closedAt && Number(m.expiresAt) > now);
}

export function getMandate(wsRoot, ticketId) {
  return readAll(wsRoot).items.find((m) => m.ticketId === String(ticketId || "")) || null;
}

function patch(wsRoot, ticketId, fields) {
  const doc = readAll(wsRoot);
  const hit = doc.items.find((m) => m.ticketId === String(ticketId || ""));
  if (!hit) return { ok: false, error: "没有这张授权" };
  Object.assign(hit, fields);
  const w = writeAll(wsRoot, doc);
  return w.ok ? { ok: true, mandate: hit } : { ok: false, error: w.error };
}

/** 人叫停：授权立刻失效，之后再要干活必须重新开一张。 */
export function revokeMandate(wsRoot, ticketId, { by = "person", reason = "", now = Date.now() } = {}) {
  return patch(wsRoot, ticketId, { revokedAt: now, revokedBy: String(by), revokeReason: String(reason || "").slice(0, 200) });
}

/** 活干完了：留结局，但不算撤销（便于回看这张授权用到哪）。 */
export function closeMandate(wsRoot, ticketId, { outcome = "completed", now = Date.now() } = {}) {
  return patch(wsRoot, ticketId, { closedAt: now, outcome: String(outcome || "completed") });
}

/**
 * 判定这张授权能不能做某个动作。
 * deny 永远赢：ALWAYS_DENIED 里的动作即使写在 scope 里也不放行。
 * @returns {{ ok:boolean, reason:string }}
 */
export function checkMandate(mandate, action, { now = Date.now() } = {}) {
  const act = String(action || "").trim();
  if (!mandate) return { ok: false, reason: "没有授权" };
  if (!act) return { ok: false, reason: "动作不明确" };
  if (mandate.revokedAt) return { ok: false, reason: "已被叫停" };
  if (mandate.closedAt) return { ok: false, reason: `这张活已经结束（${mandate.outcome || "closed"}）` };
  if (Number(mandate.expiresAt) <= now) return { ok: false, reason: "授权已过期" };
  if (ALWAYS_DENIED.includes(act)) return { ok: false, reason: `${act} 永远要人点头` };
  if (!Array.isArray(mandate.scope) || !mandate.scope.includes(act)) return { ok: false, reason: `授权范围里没有 ${act}` };
  return { ok: true, reason: "在授权范围内" };
}

/**
 * 按工单号现读现判——调用方不要拿着旧对象判（人叫停后旧对象还是旧的）。
 * @returns {{ ok:boolean, reason:string, mandate:object|null }}
 */
export function checkTicket(wsRoot, ticketId, action, { now = Date.now() } = {}) {
  const mandate = getMandate(wsRoot, ticketId);
  return { ...checkMandate(mandate, action, { now }), mandate };
}

/** 清掉过期太久（超过 7 天）的记录，避免文件无限涨。 */
export function pruneMandates(wsRoot, { now = Date.now(), keepMs = 7 * 24 * 3600 * 1000 } = {}) {
  const doc = readAll(wsRoot);
  const before = doc.items.length;
  doc.items = doc.items.filter((m) => !(Number(m.expiresAt) + keepMs < now && !m.closedAt));
  if (doc.items.length === before) return { removed: 0 };
  const w = writeAll(wsRoot, doc);
  return w.ok ? { removed: before - doc.items.length } : { removed: 0, error: w.error };
}

// ── 授权管住工具面 ──
// 只拦有风险的几类：写文件、跑命令、git/gh、发布、花钱。
// 读类永远放行（读多了是浪费，不是危险）；认不出的工具名也放行——
// 拦不认识的工具会把无关能力一起误伤，得不偿失。
export const SCOPE_OF_TOOL = Object.freeze({
  write: /^(write|edit|apply_patch|create_file|multi_edit)$/i,
  shell: /^(bash|pwsh|shell|run_code|bash_session|pwsh_session)$/i,
  git: /^(git|gh|git_commit|git_push)$/i,
  publish: /^(publish|post|upload|deploy|release)$/i,
  spend: /^(pay|purchase|spend|transfer)$/i,
});

/** 工具名属于哪一类（不属于任何受限类返回空串）。 */
export function scopeOfTool(name) {
  const n = String(name || "");
  for (const [scope, re] of Object.entries(SCOPE_OF_TOOL)) if (re.test(n)) return scope;
  return "";
}

function toolName(tool) {
  return String(tool?.function?.name || tool?.name || tool?.id || "");
}

/**
 * 按授权范围过滤工具面。
 * @returns {{ tools:Array, dropped:Array<string> }}
 */
export function filterToolsByScope(tools = [], scope = []) {
  const allowed = new Set((Array.isArray(scope) ? scope : []).map(String));
  const kept = [];
  const dropped = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = toolName(tool);
    const need = scopeOfTool(name);
    if (need && !allowed.has(need)) { dropped.push(name); continue }
    kept.push(tool);
  }
  return { tools: kept, dropped };
}
