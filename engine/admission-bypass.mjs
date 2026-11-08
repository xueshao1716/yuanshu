// ===== admission-bypass.mjs —— 旁路留痕：不堵，但要让每次绕过自证准入的操作可见（2026-11-08）=====
//
// 用户原话：「不用堵那么严重，不然她怎么自己长」——所以这里不做物理沙箱、不拦请求：
// 默认路径仍然走自证准入闸（self-change-session.finishSession → verify → admit），
// 四条仍然能绕过去的接口（apply / promote / snapshot / autopatch.merge）保持可用，
// 只在**真正写之前**往 记忆/运行时/准入旁路.jsonl 落一行记录，事后可审计。
//
// 三条硬约定：
//   1. 绝不抛错——写失败只返回 { ok:false, error }，调用方照常走原逻辑；
//   2. 所有字段截断——note ≤200 字、files ≤50 个且每个 ≤200 字、route ≤120 字、extra 序列化 ≤1000 字；
//   3. 只留最近 500 行——超了从最早的丢，账本不会无限长。
import fs from "node:fs";
import path from "node:path";

export const BYPASS_LEDGER = path.join("记忆", "运行时", "准入旁路.jsonl");
export const MAX_RECORDS = 500;
export const ROUTE_MAX = 120;
export const NOTE_MAX = 200;
export const FILES_MAX = 50;
export const FILE_MAX = 200;
export const EXTRA_MAX_CHARS = 1000;

/** 稳定标识：这四条就是目前已知的路由级旁路点。 */
export const BYPASS_ROUTES = Object.freeze([
  "selfchange.apply",
  "selfchange.promote",
  "selfchange.snapshot",
  "autopatch.merge",
]);

const clip = (v, n) => String(v ?? "").slice(0, n);

function ledgerFile(wsRoot) {
  return path.join(String(wsRoot || "."), BYPASS_LEDGER);
}

/** 读 JSONL：坏行跳过，读不到当空账本——查询和追加都不许被账本本身拖死。 */
function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean);
  } catch { return [] }
}

/** 整文件重写（临时文件 + rename），避免读到半截；失败会抛，由 recordBypass 兜。 */
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e;
  }
}

function normalizeAt(at) {
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
  if (typeof at === "number" && Number.isFinite(at)) {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const text = clip(at, 40);
  return text || new Date().toISOString();
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const rel = clip(f, FILE_MAX).trim();
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
    if (out.length >= FILES_MAX) break;
  }
  return out;
}

function normalizeExtra(extra) {
  if (extra == null) return {};
  if (typeof extra !== "object") return { value: clip(extra, 200) };
  let json = "";
  try { json = JSON.stringify(extra) } catch { return { unserializable: true } }
  if (!json) return {};
  if (json.length > EXTRA_MAX_CHARS) {
    // 截到"序列化后仍不超过上限"为止（JSON 转义会变长，所以按实际长度收缩）
    let cut = json.length;
    while (cut > 0) {
      const candidate = JSON.stringify({ truncated: json.slice(0, cut) });
      if (candidate.length <= EXTRA_MAX_CHARS) return { truncated: json.slice(0, cut) };
      cut = Math.max(0, cut - Math.max(1, candidate.length - EXTRA_MAX_CHARS));
    }
    return { truncated: "" };
  }
  try { return JSON.parse(json) } catch { return {} }
}

/** 纯函数：把调用方给的东西压成一条定长记录（单测直接测它，不碰磁盘）。 */
export function normalizeBypass({ route, files, note, at, extra } = {}) {
  return {
    at: normalizeAt(at),
    route: clip(route, ROUTE_MAX).trim() || "unknown",
    files: normalizeFiles(files),
    note: clip(note, NOTE_MAX),
    extra: normalizeExtra(extra),
  };
}

/**
 * 追加一条旁路记录。**绝不抛错**：任何失败都只回 { ok:false, error }。
 * @param {{wsRoot?:string, route?:string, files?:string[], note?:string, at?:string|number|Date, extra?:object}} opts
 */
export function recordBypass({ wsRoot, route, files = [], note = "", at, extra } = {}) {
  try {
    const record = normalizeBypass({ route, files, note, at, extra });
    const file = ledgerFile(wsRoot);
    const rows = readJsonl(file);
    rows.push(record);
    const kept = rows.slice(-MAX_RECORDS);
    writeJsonl(file, kept);
    return { ok: true, record, kept: kept.length, dropped: rows.length - kept.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 倒序（最新在前）读最近 limit 条；账本坏了也只是少几条，不抛。 */
export function listBypasses(wsRoot, { limit = 50 } = {}) {
  const n = Number(limit);
  const size = Math.max(1, Math.min(MAX_RECORDS, Number.isFinite(n) ? Math.trunc(n) : 50));
  try {
    return readJsonl(ledgerFile(wsRoot)).slice(-size).reverse();
  } catch { return [] }
}

/** 账本总条数（接口里回 total 用；读不到就是 0）。 */
export function countBypasses(wsRoot) {
  try { return readJsonl(ledgerFile(wsRoot)).length } catch { return 0 }
}
