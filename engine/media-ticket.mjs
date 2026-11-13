// ===== engine/media-ticket.mjs —— 短时媒体票据（安全审计 AUTH-003，2026-11-13）=====
//
// 问题：<img>/<audio>/<video>/SSE 带不了 Authorization 头，以前只能把 ?token=<长期令牌>
// 拼进 URL。长期令牌一旦进 URL，就会跟着进浏览器历史、代理访问日志、Referer。
//
// 方案：用 Bearer 换一张 60 秒、只对某类路径有效的 HMAC 票据，URL 里只出现票据。
//   ticket = base64url(payload) + "." + base64url(HMAC-SHA256(key, base64url(payload)))
//   payload = { scope, exp, nonce }   // exp 是毫秒时间戳
//   key     = HMAC-SHA256(secret = CONFIG.token, "yuanshu/media-ticket/v1") 派生出的 32 字节
//
// 边界：
//   - 密钥只从内存里的令牌派生，**不落盘、不写日志**；令牌文件被改 → 旧票据立刻失效。
//   - 票据无状态（不存表）；nonce 只为将来做一次性消费/审计关联留位置，60 秒 TTL 才是主要控制。
//   - scope 前缀匹配：票据 "file:" 能过 "file:"；"stream:" 能过 "stream:music"；
//     "stream:music" 过不了 "stream:notify"。空 scope 一律不匹配（防止换到一张万能票）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, "..", ".token");

const KEY_CONTEXT = "yuanshu/media-ticket/v1";
export const DEFAULT_TICKET_TTL_MS = 60_000;
export const MAX_TICKET_TTL_MS = 300_000;
const MAX_SCOPE_LENGTH = 120;

// 允许换票的 scope 前缀：与 checkAuth 的白名单路径一一对应（file/media/stream）。
export const ALLOWED_TICKET_SCOPE_PREFIXES = ["file:", "media:", "stream:"];

let _key = null;

function deriveKey(secret) {
  return crypto.createHmac("sha256", String(secret)).update(KEY_CONTEXT).digest();
}

/** 用当前访问令牌（.token / CONFIG.token）派生票据密钥。换令牌时必须重新调用。 */
export function configureTicketKey(secret) {
  const raw = typeof secret === "string" ? secret.trim() : "";
  if (!raw) throw new Error("票据密钥不能为空");
  _key = deriveKey(raw);
  return true;
}

function ticketKey() {
  if (_key) return _key;
  // 兜底：没显式配置就现读仓库根的 .token（只派生，不缓存明文）。
  try {
    const fromFile = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (fromFile) { _key = deriveKey(fromFile); return _key; }
  } catch {}
  throw new Error("缺少票据密钥：请先 configureTicketKey(CONFIG.token)");
}

function normalizeScope(scope) {
  const s = typeof scope === "string" ? scope.trim() : "";
  if (!s) throw new Error("scope 不能为空");
  if (s.length > MAX_SCOPE_LENGTH) throw new Error(`scope 过长（上限 ${MAX_SCOPE_LENGTH}）`);
  if (/[\s\u0000-\u001f\u007f]/.test(s)) throw new Error("scope 含空白或控制字符");
  return s;
}

function normalizeTtl(ttlMs) {
  const n = Number(ttlMs);
  if (!Number.isFinite(n) || n <= 0) throw new Error("ttlMs 必须是正数");
  return Math.min(Math.round(n), MAX_TICKET_TTL_MS);
}

/** 该请求路径需要哪一类票据；空串 = 这条路径不接受 URL 票据（只认 Bearer）。 */
export function ticketScopeForPath(pathname) {
  const p = typeof pathname === "string" ? pathname : "";
  if (p === "/api/ws/file") return "file:";
  if (p.startsWith("/api/media/")) return "media:";
  // 只认 /api/<一段>/stream（/api/sessions/<id>/stream 这种多段的仍只走 Authorization 头）
  const stream = /^\/api\/([A-Za-z0-9_-]+)\/stream$/.exec(p);
  if (stream) return `stream:${stream[1]}`;
  return "";
}

export function isTicketScopeAllowed(scope) {
  let s;
  try { s = normalizeScope(scope); } catch { return false; }
  return ALLOWED_TICKET_SCOPE_PREFIXES.some(prefix => s.startsWith(prefix));
}

function scopeMatches(ticketScope, requiredScope) {
  const t = typeof ticketScope === "string" ? ticketScope : "";
  const r = typeof requiredScope === "string" ? requiredScope : "";
  if (!t || !r) return false;
  return r === t || r.startsWith(t);
}

/** 签发一张票据。返回 { ticket, exp }；ttlMs 默认 60 秒，上限 5 分钟。 */
export function issueTicket({ scope, ttlMs = DEFAULT_TICKET_TTL_MS, now = Date.now(), nonce } = {}) {
  const normalized = normalizeScope(scope);
  const ttl = normalizeTtl(ttlMs);
  const issuedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const payload = {
    scope: normalized,
    exp: issuedAt + ttl,
    nonce: typeof nonce === "string" && nonce ? nonce.slice(0, 64) : crypto.randomBytes(12).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", ticketKey()).update(body).digest().toString("base64url");
  return { ticket: `${body}.${sig}`, exp: payload.exp };
}

/**
 * 校验票据：签名 → 过期 → scope 前缀。
 * 返回 { ok: true, scope, exp } 或 { ok: false, reason }，reason ∈ malformed|bad_signature|expired|scope_mismatch。
 */
export function verifyTicket(ticket, { scope, now = Date.now() } = {}) {
  if (typeof ticket !== "string" || ticket.length < 8 || ticket.length > 2048) return { ok: false, reason: "malformed" };
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0 || dot === ticket.length - 1) return { ok: false, reason: "malformed" };
  const body = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);

  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "malformed" };
  if (typeof payload.scope !== "string" || !payload.scope) return { ok: false, reason: "malformed" };
  if (!Number.isFinite(payload.exp)) return { ok: false, reason: "malformed" };
  if (typeof payload.nonce !== "string" || !payload.nonce) return { ok: false, reason: "malformed" };

  let given;
  try { given = Buffer.from(sig, "base64url"); } catch { return { ok: false, reason: "malformed" }; }
  const expected = crypto.createHmac("sha256", ticketKey()).update(body).digest();
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };

  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (!(at < payload.exp)) return { ok: false, reason: "expired" };
  if (!scopeMatches(payload.scope, scope)) return { ok: false, reason: "scope_mismatch" };
  return { ok: true, scope: payload.scope, exp: payload.exp };
}
