// ===== approval-token.mjs —— 一次性审批凭据（2026-10-28）=====
//
// 设计借鉴 Inalpha 的 order approval（**只借思路，不抄代码**）：
//   高危动作不能只靠一个 boolean（"我点过确认了"），要走「申请 → 拿一次性凭据 → 凭据执行」，
//   凭据特性：
//     · **单次消费**：用过即废，重放无效；
//     · **TTL 绑定**：过期作废（默认 10 分钟）；
//     · **绑定动作 + 载荷哈希**：凭据只对"那一个动作、那一份内容"有效 ——
//       防止"批准的是 A，执行的是 B"（TOCTOU）。
//
// 元枢里第一个用它的是**自动补丁合并**：凭据绑到分支 HEAD 的 commit sha，
// 合并时 sha 变了就作废（有人又提交了新东西，你批准的东西已经不是现在的东西了）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const TOKENS_REL = path.join("记忆", "运行时", "审批凭据.json");
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const MAX_TOKENS = 200;

const fileOf = (ws) => path.join(String(ws || "."), TOKENS_REL);
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

export function payloadDigest(payload) {
  // 载荷按稳定顺序序列化，避免 key 顺序不同导致哈希不同
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
    }
    return v;
  };
  return sha256(JSON.stringify(stable(payload ?? {})));
}

export function readTokens(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsRoot), "utf8"));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch {}
  return { v: 1, items: [] };
}

function writeTokens(wsRoot, data) {
  fs.mkdirSync(path.dirname(fileOf(wsRoot)), { recursive: true });
  const tmp = `${fileOf(wsRoot)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...data, v: 1, updatedAt: Date.now() }, null, 2), "utf8");
  fs.renameSync(tmp, fileOf(wsRoot)); // 原子替换：半截文件不会被读到
}

/**
 * 申请凭据。
 * @param {{wsRoot:string, action:string, payload:object, ttlMs?:number, issuedBy?:string, now?:number}} p
 * @returns {{ok:boolean, token?:string, record?:object, error?:string}}
 */
export function issueToken({ wsRoot, action, payload = {}, ttlMs = DEFAULT_TTL_MS, issuedBy = "小语", now = Date.now() } = {}) {
  const act = String(action || "").trim();
  if (!act) return { ok: false, error: "action 不能为空" };

  const token = crypto.randomBytes(24).toString("base64url");
  const record = {
    id: `t-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    action: act,
    payloadHash: payloadDigest(payload),
    payloadPreview: JSON.stringify(payload ?? {}).slice(0, 300),
    tokenHash: sha256(token),
    issuedBy: String(issuedBy || "小语").slice(0, 40),
    issuedAt: now,
    expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS),
    usedAt: null,
  };
  const data = readTokens(wsRoot);
  data.items = [record, ...(data.items || [])].slice(0, MAX_TOKENS);
  writeTokens(wsRoot, data);
  // 只在这一刻把明文交出去；落盘只存哈希
  return { ok: true, token, record: { ...record, tokenHash: undefined } };
}

/**
 * 消费凭据（成功即作废）。
 * @returns {{ok:boolean, record?:object, error?:string, reason?:string}}
 */
export function consumeToken({ wsRoot, token, action, payload = {}, now = Date.now() } = {}) {
  const raw = String(token || "").trim();
  if (!raw) return { ok: false, reason: "missing", error: "没有凭据" };
  const data = readTokens(wsRoot);
  const hash = sha256(raw);
  const rec = (data.items || []).find((t) => t.tokenHash === hash);
  if (!rec) return { ok: false, reason: "unknown", error: "凭据无效" };
  if (rec.usedAt) return { ok: false, reason: "used", error: `凭据已用过（${new Date(rec.usedAt).toLocaleString("zh-CN", { hour12: false })}）` };
  if (Number(rec.expiresAt) <= now) return { ok: false, reason: "expired", error: "凭据已过期，请重新确认一次" };
  if (action && rec.action !== action) return { ok: false, reason: "action_mismatch", error: `凭据是为「${rec.action}」发的，不是「${action}」` };
  const want = payloadDigest(payload);
  if (rec.payloadHash !== want) {
    return { ok: false, reason: "payload_mismatch", error: "要执行的内容和当初批准的不一致（可能又被改过），请重新确认" };
  }
  rec.usedAt = now;
  rec.usedBy = action || rec.action;
  writeTokens(wsRoot, data);
  return { ok: true, record: { ...rec, tokenHash: undefined } };
}

/** 清理过期且未使用的（省得越堆越多）。 */
export function pruneTokens({ wsRoot, now = Date.now(), keepMs = 7 * 86400_000 } = {}) {
  const data = readTokens(wsRoot);
  const before = (data.items || []).length;
  data.items = (data.items || []).filter((t) => t.usedAt ? now - t.usedAt < keepMs : Number(t.expiresAt) > now - keepMs);
  const removed = before - data.items.length;
  if (removed) writeTokens(wsRoot, data);
  return { removed };
}

export function listTokens(wsRoot, { limit = 20, onlyValid = false, now = Date.now() } = {}) {
  return (readTokens(wsRoot).items || [])
    .filter((t) => !onlyValid || (!t.usedAt && Number(t.expiresAt) > now))
    .slice(0, Math.max(1, limit))
    .map((t) => ({ ...t, tokenHash: undefined }));
}
