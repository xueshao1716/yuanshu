// ===== watch-log.mjs —— 值班日志的按天切分 / 2MB 滚动 / 30 天清理（2026-11-07）=====
//
// 值班日志原来只有一个 值班日志.jsonl，超过 2MB 就改名成 .1——旧文件既不归档也不清理，
// 查问题时只能看到最近两天。现在改成：
//   ① 按本地日期切分：记忆/运行时/值班日志-YYYYMMDD.jsonl（一天一个文件，好找、好删）；
//   ② 单文件超过 2MB：滚动到 记忆/运行时/值班归档/值班日志-YYYYMMDD-HHMMSS-SSS.jsonl；
//   ③ 保留最近 30 天：按文件名里的日期判，超期删除，支持 dry-run（先看会删谁）。
//
// 这里尽量把「命名 / 判定 / 选择」写成不碰磁盘的纯函数（watch-log.test.mjs 直接测），
// 只有 append/rotate/cleanup 三个函数碰 fs，且都允许注入 fsMod 方便测试。
import fs from "node:fs";
import path from "node:path";

export const WATCH_LOG_BASENAME = "值班日志.jsonl";
export const WATCH_LOG_STEM = "值班日志";
export const WATCH_ARCHIVE_DIRNAME = "值班归档";
export const LOG_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_KEEP_DAYS = 30;
// 清理是附加动作：最多每 6 小时扫一次目录，别每次写一行日志都 readdir。
export const CLEANUP_INTERVAL_MS = 6 * 3600_000;

const pad2 = (n) => String(n).padStart(2, "0");

/** 本地日期键（YYYYMMDD）。日志按人的本地日期切，不用 UTC——否则北京时间早上 8 点前的记录会落到前一天。 */
export function localDayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** 本地当天 00:00 的时间戳（保留最近 N 天时以「日」为粒度）。 */
export function localDayStart(now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 当天的日志文件名，如 值班日志-20261107.jsonl。 */
export function watchLogFileName(now = Date.now(), stem = WATCH_LOG_STEM) {
  return `${stem}-${localDayKey(now)}.jsonl`;
}

/**
 * 由「基准日志路径」推出当天的日志路径。
 * 传入 值班日志.jsonl → 同目录 值班日志-YYYYMMDD.jsonl；
 * 传入已经是 值班日志-YYYYMMDD.jsonl → 原样返回（幂等，wake 与 duty 共用同一入口）。
 */
export function dailyLogPath(baseFile, now = Date.now()) {
  const p = String(baseFile || "");
  if (!p) return "";
  const stem = path.basename(p, ".jsonl");
  if (/-\d{8}$/.test(stem)) return p;
  return path.join(path.dirname(p), watchLogFileName(now, stem));
}

/** 滚动归档的文件名（带时间戳，同一毫秒内多次滚动用 seq 去重）。 */
export function archiveFileName(now = Date.now(), seq = 0, stem = WATCH_LOG_STEM) {
  const d = new Date(now);
  const stamp = `${localDayKey(now)}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}`;
  return `${stem}-${stamp}${seq ? `-${seq}` : ""}.jsonl`;
}

/** 从日志文件名里取出「哪天」（本地 00:00 的时间戳）；不认识的名字返回 null。 */
export function logDayMs(name) {
  const m = String(name || "").match(/-(\d{8})(?:-\d{6}(?:-\d{1,3})?(?:-\d+)?)?\.jsonl$/);
  if (!m) return null;
  const y = Number(m[1].slice(0, 4));
  const mo = Number(m[1].slice(4, 6));
  const da = Number(m[1].slice(6, 8));
  if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return null;
  const d = new Date(y, mo - 1, da);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  return d.getTime();
}

/** 单文件是否该滚动：严格大于上限才滚（与旧逻辑一致）。 */
export function shouldRotate(size, maxBytes = LOG_MAX_BYTES) {
  return Number(size) > Number(maxBytes);
}

/**
 * 纯函数：从文件名列表里挑出超过保留天数的那些。
 * 保留「最近 keepDays 个自然日」：keepDays=30 时，今天与往前 29 天都留，第 30 天前（含）删。
 */
export function selectExpiredLogNames(names, { now = Date.now(), keepDays = LOG_KEEP_DAYS, stem = WATCH_LOG_STEM } = {}) {
  const keep = Math.max(1, Math.round(Number(keepDays) || LOG_KEEP_DAYS));
  const cutoff = localDayStart(now) - (keep - 1) * 86400_000;
  return (Array.isArray(names) ? names : [])
    .filter((n) => {
      const name = String(n || "");
      if (stem && !name.startsWith(`${stem}-`)) return false;
      const day = logDayMs(name);
      return day != null && day < cutoff;
    })
    .sort();
}

/** 目录不存在/读不了时当作空目录（日志清理不该阻断值班）。 */
function safeReaddir(fsMod, dir) {
  try {
    return fsMod.readdirSync(dir).map(String);
  } catch {
    return [];
  }
}

/**
 * 把超过 2MB 的当天日志滚进 值班归档/。
 * rename 是同卷原子操作：滚动期间不会出现半截文件。
 */
export function rotateWatchLog(logFile, { now = Date.now(), archiveDir = "", fsMod = fs, stem = "" } = {}) {
  const src = String(logFile || "");
  if (!src) return { ok: false, reason: "no-file" };
  // 传进来的可能是「按天文件」值班日志-20261107.jsonl；归档名前缀要去掉日期段，否则日期会叠两遍。
  const rawStem = stem || path.basename(src, ".jsonl");
  const prefix = rawStem.replace(/-\d{8}$/, "") || rawStem;
  const targetDir = archiveDir || path.join(path.dirname(src), WATCH_ARCHIVE_DIRNAME);
  try {
    fsMod.mkdirSync(targetDir, { recursive: true });
    const existing = new Set(safeReaddir(fsMod, targetDir));
    let seq = 0;
    let name = archiveFileName(now, 0, prefix);
    while (existing.has(name)) {
      seq += 1;
      name = archiveFileName(now, seq, prefix);
    }
    const target = path.join(targetDir, name);
    fsMod.renameSync(src, target);
    return { ok: true, archive: target, name };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 160) };
  }
}

/**
 * 清理超过保留期的日志：当天日志 + 归档日志都清。
 * dryRun=true 只返回会删哪些，不动磁盘（测试与人工巡检用）。
 */
export function cleanupWatchLogs(baseFile, { now = Date.now(), keepDays = LOG_KEEP_DAYS, dryRun = false, fsMod = fs } = {}) {
  const base = String(baseFile || "");
  if (!base) return { ok: false, reason: "no-file", dryRun: !!dryRun };
  const dir = path.dirname(base);
  const stem = path.basename(base, ".jsonl");
  const archiveDir = path.join(dir, WATCH_ARCHIVE_DIRNAME);
  const dailyNames = safeReaddir(fsMod, dir).filter((n) => n.startsWith(`${stem}-`) && n.endsWith(".jsonl"));
  const archiveNames = safeReaddir(fsMod, archiveDir).filter((n) => n.endsWith(".jsonl"));
  const opts = { now, keepDays, stem };
  const daily = selectExpiredLogNames(dailyNames, opts);
  const archives = selectExpiredLogNames(archiveNames, opts);
  const wouldRemove = [
    ...daily.map((n) => path.join(dir, n)),
    ...archives.map((n) => path.join(archiveDir, n)),
  ];
  const removed = [];
  if (!dryRun) {
    for (const p of wouldRemove) {
      try { fsMod.unlinkSync(p); removed.push(p); } catch { /* 删不动就留着，下轮再试 */ }
    }
  }
  return {
    ok: true,
    dryRun: !!dryRun,
    keepDays: Math.max(1, Math.round(Number(keepDays) || LOG_KEEP_DAYS)),
    daily,
    archives,
    wouldRemove,
    removed,
    scanned: dailyNames.length + archiveNames.length,
  };
}

// 清理节流：同一个基准日志目录 6 小时内只扫一次。
const _lastCleanupAt = new Map();

function maybeCleanup(baseFile, now, fsMod) {
  const key = String(baseFile || "");
  const last = _lastCleanupAt.get(key) || 0;
  if (now - last < CLEANUP_INTERVAL_MS) return null;
  _lastCleanupAt.set(key, now);
  return cleanupWatchLogs(baseFile, { now, fsMod });
}

/**
 * 追加一行 JSONL 值班日志（对外唯一入口，duty 与 wake 共用）：
 *   ① 按 now 落到当天的日志文件；
 *   ② 当天文件已超 2MB → 先滚进归档；
 *   ③ 顺带（节流）清理 30 天前的日志。
 * 任何失败都静默返回 ok:false——日志写不进去不该影响值守本身。
 */
export function appendWatchLog(logFile, entry, now = Date.now(), { fsMod = fs } = {}) {
  const base = String(logFile || "");
  if (!base) return { ok: false, reason: "no-file" };
  try {
    const file = dailyLogPath(base, now);
    fsMod.mkdirSync(path.dirname(file), { recursive: true });
    let rotated = false;
    try {
      if (shouldRotate(fsMod.statSync(file).size)) {
        rotated = rotateWatchLog(file, { now, fsMod }).ok === true;
      }
    } catch { /* 当天第一次写，文件还不存在 */ }
    fsMod.appendFileSync(file, `${JSON.stringify({ at: now, ...entry })}\n`, "utf8");
    maybeCleanup(base, now, fsMod);
    return { ok: true, file, rotated };
  } catch {
    return { ok: false };
  }
}
