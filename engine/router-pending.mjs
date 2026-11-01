// ===== router-pending.mjs —— ask 的回执闭环（2026-11-01）=====
//
// 问题：路由器判了 ask、推了消息，但没有"待你拍板"的台账，也没有"你回一句就接着办"的链路。
// 这里补三件事：
//   ① 待办落盘（谁问的、问什么、批准后要做什么）
//   ② 回执解析（"删吧/可以"=同意，"算了/别"=拒绝，"再看看"=不明确）
//   ③ 解决即执行/丢弃，24 小时自动过期（不替你做决定，只是不再挂着）
import fs from "node:fs";
import path from "node:path";

export const PENDING_REL = path.join("记忆", "运行时", "路由待办.json");
export const EXPIRE_MS = 24 * 60 * 60 * 1000;

const APPROVE = /(同意|可以|行|好|删吧|做吧|干吧|去吧|点头|批准|^ok$|^OK$|^y$|^是$)/i;
const DENY = /(不用|不要|算了|别|取消|拒绝|先不|不删|不做|^no$|^n$)/i;
const WEAK = /(再想想|看看|等下|稍后|待定|不确定)/;

export function pendingFile(wsRoot) {
  return path.join(String(wsRoot || "."), PENDING_REL);
}

function readDoc(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingFile(wsRoot), "utf8"));
    return { items: Array.isArray(raw?.items) ? raw.items : [] };
  } catch { return { items: [] } }
}

function writeDoc(wsRoot, doc) {
  const file = pendingFile(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ items: doc.items.slice(-100) }, null, 2), "utf8");
  return doc;
}

/** 建一条待拍板（过期时间默认 24h）。 */
export function createAsk(wsRoot, { source = "", text = "", reason = "", task = "", now = Date.now() } = {}) {
  const doc = readDoc(wsRoot);
  const row = {
    id: `ask-${String(now).slice(-6)}-${Math.random().toString(36).slice(2, 6)}`,
    at: now, source: String(source).slice(0, 40), text: String(text).slice(0, 500),
    reason: String(reason).slice(0, 200), task: String(task).slice(0, 1500),
    state: "pending", expiresAt: now + EXPIRE_MS,
  };
  doc.items.push(row);
  writeDoc(wsRoot, doc);
  return row;
}

/** 列出待办；顺手把过期的标成 expired。 */
export function listAsks(wsRoot, { state = "", now = Date.now() } = {}) {
  const doc = readDoc(wsRoot);
  let changed = false;
  for (const it of doc.items) {
    if (it.state === "pending" && it.expiresAt && now > it.expiresAt) { it.state = "expired"; changed = true }
  }
  if (changed) writeDoc(wsRoot, doc);
  return state ? doc.items.filter((x) => x.state === state) : doc.items;
}

/** 解析回执：approve / deny / unclear。 */
export function parseReply(text) {
  const t = String(text || "").trim();
  if (!t) return { kind: "unclear" };
  if (WEAK.test(t)) return { kind: "unclear", reason: "看起来还在犹豫" };
  if (DENY.test(t)) return { kind: "deny" };
  if (APPROVE.test(t)) return { kind: "approve" };
  return { kind: "unclear" };
}

/** 找到要回执的那条：只有一条待办就直接用；多条按关键词重合挑最像的。 */
export function pickAsk(wsRoot, text, { now = Date.now() } = {}) {
  const pending = listAsks(wsRoot, { state: "pending", now });
  if (!pending.length) return null;
  if (pending.length === 1) return pending[0];
  const t = String(text || "");
  let best = null, bestScore = 0;
  for (const p of pending) {
    const words = `${p.text} ${p.reason}`.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    const score = words.filter((w) => t.includes(w)).length;
    if (score > bestScore) { best = p; bestScore = score }
  }
  return best || pending[pending.length - 1];
}

/** 结掉一条（approve / deny / expired），返回结掉的那条。 */
export function resolveAsk(wsRoot, id, { state = "approved", note = "", now = Date.now() } = {}) {
  const doc = readDoc(wsRoot);
  const hit = doc.items.find((x) => x.id === id);
  if (!hit) return { ok: false, error: "找不到这条待办" };
  if (hit.state !== "pending") return { ok: false, error: `已经是 ${hit.state}` };
  hit.state = state;
  hit.resolvedAt = now;
  hit.note = String(note).slice(0, 200);
  writeDoc(wsRoot, doc);
  return { ok: true, ask: hit };
}

/**
 * 处理一句可能是回执的话。
 * @returns {{handled:boolean, kind:string, ask?:object}}
 */
export function handleReply(wsRoot, text, { now = Date.now() } = {}) {
  const parsed = parseReply(text);
  if (parsed.kind === "unclear") return { handled: false, kind: parsed.kind };
  const ask = pickAsk(wsRoot, text, { now });
  if (!ask) return { handled: false, kind: parsed.kind, reason: "没有待拍板的事" };
  const out = resolveAsk(wsRoot, ask.id, { state: parsed.kind === "approve" ? "approved" : "denied", note: String(text).slice(0, 120), now });
  return { handled: out.ok, kind: parsed.kind, ask: out.ok ? out.ask : ask, error: out.error };
}

/** 深夜不推（0–7 点），除非社交权重很高。 */
export function quietHours(now = Date.now(), weight = 0.5) {
  const h = new Date(now).getHours();
  const quiet = h >= 0 && h < 7;
  return quiet && Number(weight) < 0.8;
}
