// ===== thread-inbox.mjs —— 话题收件箱（2026-11-07）=====
//
// 为什么需要：订阅直通判定出「这条事件归某个 worker」之后，总得有个地方先把事件接住。
// 元枢的派活走「定时任务 → unifiedChat」，没有可 steer 的 run，所以不能像 DSH 那样
// 直接塞进运行中的会话；按 Super-agent 原文 2.1 的批处理思路，先按话题落盘，
// 等该话题的下一次任务启动时一次性 drain 进来——积压合并，正是它 batching 的做法。
//
// 只做落盘与取用，不做判断（判断在 thread-router / thread-delivery）。
import fs from "node:fs";
import path from "node:path";

export const INBOX_DIR = path.join("记忆", "运行时", "话题收件箱");
const MAX_PER_THREAD = 200; // 单话题最多留这么多条，超了丢最旧的

export function inboxDir(wsRoot) {
  return path.join(String(wsRoot || "."), INBOX_DIR);
}

/** 话题键 → 安全文件名。保留可读部分，再加短哈希防撞（crc32）。 */
export function inboxFile(wsRoot, threadKey) {
  const key = String(threadKey || "").trim();
  if (!key) return "";
  const readable = key.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);
  return path.join(inboxDir(wsRoot), `${readable}-${crc32(key)}.jsonl`);
}

function crc32(s) {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i += 1) {
    c ^= s.charCodeAt(i);
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((x) => x.trim());
  } catch {
    return [];
  }
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** 入队一条事件。返回入队后的条数；空键或不写盘返回 0。 */
export function enqueue(wsRoot, threadKey, event = {}, { now = Date.now(), persist = true } = {}) {
  const file = inboxFile(wsRoot, threadKey);
  if (!file) return 0;
  const row = {
    threadKey: String(threadKey),
    at: now,
    source: String(event.source || ""),
    kind: String(event.kind || ""),
    text: String(event.text || "").slice(0, 4000),
    meta: event.meta && typeof event.meta === "object" ? event.meta : undefined,
  };
  const lines = readLines(file);
  lines.push(JSON.stringify(row));
  const kept = lines.slice(-MAX_PER_THREAD);
  if (persist) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${kept.join("\n")}\n`, "utf8");
    } catch { return 0 }
  }
  return kept.length;
}

/** 看一眼（不取走）。 */
export function peek(wsRoot, threadKey, { limit = 20 } = {}) {
  const file = inboxFile(wsRoot, threadKey);
  if (!file) return [];
  return readLines(file).slice(-limit).map(parse).filter(Boolean);
}

/** 取走并清空。返回按时间正序的事件数组。 */
export function drain(wsRoot, threadKey, { limit = 50 } = {}) {
  const file = inboxFile(wsRoot, threadKey);
  if (!file) return [];
  const all = readLines(file).map(parse).filter(Boolean);
  if (!all.length) return [];
  const taken = all.slice(0, limit);
  const rest = all.slice(limit);
  try {
    if (rest.length) fs.writeFileSync(file, `${rest.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");
    else fs.rmSync(file, { force: true });
  } catch {}
  return taken;
}

/** 当前积压条数。 */
export function size(wsRoot, threadKey) {
  const file = inboxFile(wsRoot, threadKey);
  return file ? readLines(file).length : 0;
}

/** 全部话题的积压（给 /api/threads 看）。 */
export function listInboxes(wsRoot) {
  const dir = inboxDir(wsRoot);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return [] }
  return names.map((name) => {
    const rows = readLines(path.join(dir, name)).map(parse).filter(Boolean);
    return {
      file: name,
      threadKey: rows[rows.length - 1]?.threadKey || "",
      size: rows.length,
      lastAt: rows[rows.length - 1]?.at || 0,
      preview: String(rows[rows.length - 1]?.text || "").slice(0, 80),
    };
  }).sort((a, b) => b.lastAt - a.lastAt);
}
