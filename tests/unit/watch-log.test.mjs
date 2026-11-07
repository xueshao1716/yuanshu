// 值班日志（第五条不足）：按天切分、单文件 2MB 滚动到 值班归档/、保留最近 30 天，清理支持 dry-run。
// 命名/选择是纯函数，直接测；落盘用临时目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendWatchLog, archiveFileName, cleanupWatchLogs, dailyLogPath, logDayMs,
  selectExpiredLogNames, shouldRotate, watchLogFileName,
  LOG_MAX_BYTES, WATCH_ARCHIVE_DIRNAME,
} from "../../engine/watch-log.mjs";

const DAY = 86400_000;
const T = new Date(2026, 10, 7, 13, 45, 12, 345).getTime(); // 本地 2026-11-07 13:45:12.345

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "watch-log-")); }
function baseLog(dir) { return path.join(dir, "记忆", "运行时", "值班日志.jsonl"); }
function readLines(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("命名与日期解析：按本地日期切、归档带时间戳、幂等", () => {
  assert.equal(watchLogFileName(T), "值班日志-20261107.jsonl");
  const base = path.join("C:", "ws", "记忆", "运行时", "值班日志.jsonl");
  assert.equal(dailyLogPath(base, T), path.join("C:", "ws", "记忆", "运行时", "值班日志-20261107.jsonl"));
  const daily = dailyLogPath(base, T);
  assert.equal(dailyLogPath(daily, new Date(2026, 11, 1).getTime()), daily, "已经是按天文件就不要再套一层");
  assert.equal(archiveFileName(T), "值班日志-20261107-134512-345.jsonl");
  assert.equal(archiveFileName(T, 2), "值班日志-20261107-134512-345-2.jsonl");

  assert.equal(logDayMs("值班日志-20261107.jsonl"), new Date(2026, 10, 7).getTime());
  assert.equal(logDayMs("值班日志-20261107-134512-345.jsonl"), new Date(2026, 10, 7).getTime());
  assert.equal(logDayMs("值班日志-20261399.jsonl"), null, "非法日期不认");
  assert.equal(logDayMs("别的日志-20261107.jsonl"), new Date(2026, 10, 7).getTime(), "解析只看日期段");
  assert.equal(logDayMs("README.md"), null);

  assert.equal(shouldRotate(LOG_MAX_BYTES), false, "正好 2MB 不滚");
  assert.equal(shouldRotate(LOG_MAX_BYTES + 1), true);
});

test("按天切分：不同日期落到不同文件，基准文件本身不再写", () => {
  const dir = tempDir();
  try {
    const base = baseLog(dir);
    const d1 = new Date(2026, 10, 7, 9, 0, 0).getTime();
    const d2 = new Date(2026, 10, 8, 9, 0, 0).getTime();
    appendWatchLog(base, { event: "a" }, d1);
    appendWatchLog(base, { event: "b" }, d1);
    appendWatchLog(base, { event: "c" }, d2);

    const f1 = path.join(dir, "记忆", "运行时", "值班日志-20261107.jsonl");
    const f2 = path.join(dir, "记忆", "运行时", "值班日志-20261108.jsonl");
    assert.ok(fs.existsSync(f1));
    assert.ok(fs.existsSync(f2));
    assert.equal(fs.existsSync(base), false, "不再往老的 值班日志.jsonl 里写");
    assert.deepEqual(readLines(f1).map((x) => x.event), ["a", "b"]);
    assert.deepEqual(readLines(f2).map((x) => x.event), ["c"]);
    assert.ok(readLines(f1)[0].at, "每行都要带 at");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("2MB 滚动：旧内容进 值班归档/，当天文件从新一行重新开始", () => {
  const dir = tempDir();
  try {
    const base = baseLog(dir);
    const daily = dailyLogPath(base, T);
    fs.mkdirSync(path.dirname(daily), { recursive: true });
    fs.writeFileSync(daily, "x".repeat(LOG_MAX_BYTES + 10), "utf8");

    appendWatchLog(base, { event: "after-rotate" }, T);
    assert.ok(fs.statSync(daily).size < 1000, "当天的文件只剩新写的一行");
    assert.deepEqual(readLines(daily).map((x) => x.event), ["after-rotate"]);

    const archiveDir = path.join(dir, "记忆", "运行时", WATCH_ARCHIVE_DIRNAME);
    const files = fs.readdirSync(archiveDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^值班日志-20261107-\d{6}-\d{3}\.jsonl$/);
    const old = fs.readFileSync(path.join(archiveDir, files[0]), "utf8");
    assert.ok(old.startsWith("xxx"));
    assert.equal(old.length, LOG_MAX_BYTES + 10, "归档内容不丢");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("30 天保留：dry-run 只列出、不动文件；真跑才删，且只删超期日志", () => {
  const dir = tempDir();
  try {
    const base = baseLog(dir);
    const logDir = path.dirname(base);
    const archiveDir = path.join(logDir, WATCH_ARCHIVE_DIRNAME);
    fs.mkdirSync(archiveDir, { recursive: true });
    // 今天往前 0..34 天，每天一个归档文件；再加一个无关文件
    for (let i = 0; i < 35; i++) {
      const name = archiveFileName(T - i * DAY, 0);
      fs.writeFileSync(path.join(archiveDir, name), "{}\n", "utf8");
    }
    fs.writeFileSync(path.join(archiveDir, "README.txt"), "not a log", "utf8");
    // 一个 40 天前的按天日志（也该清）
    const oldDaily = path.join(logDir, watchLogFileName(T - 40 * DAY));
    fs.writeFileSync(oldDaily, "{}\n", "utf8");

    const dry = cleanupWatchLogs(base, { now: T, keepDays: 30, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.removed.length, 0, "dry-run 不许删文件");
    // i=30..34 共 5 个归档超期；i=29 刚好在保留窗口内
    assert.equal(dry.archives.length, 5);
    assert.equal(dry.daily.length, 1, "40 天前的按天日志也要清");
    assert.equal(dry.wouldRemove.length, 6);
    for (const p of dry.wouldRemove) assert.ok(fs.existsSync(p), "dry-run 后文件都还在");

    const real = cleanupWatchLogs(base, { now: T, keepDays: 30 });
    assert.equal(real.archives.length, 5);
    assert.equal(real.removed.length, 6);
    for (const p of real.removed) assert.equal(fs.existsSync(p), false);
    // 保留窗口内（0..29 天）一个不少
    for (let i = 0; i <= 29; i++) {
      assert.ok(fs.existsSync(path.join(archiveDir, archiveFileName(T - i * DAY, 0))), `第 ${i} 天的归档应保留`);
    }
    assert.ok(fs.existsSync(path.join(archiveDir, "README.txt")), "非日志文件不动");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("纯函数选超期：不认的名字不碰，keepDays 可调", () => {
  const names = [
    "值班日志-20261107.jsonl",
    "值班日志-20261001-120000-000.jsonl", // 37 天前
    "值班日志-20261106-235959-999.jsonl",
    "读书笔记-20200101.jsonl",
    "值班日志-坏日期.jsonl",
  ];
  const expired = selectExpiredLogNames(names, { now: T, keepDays: 30 });
  assert.deepEqual(expired, ["值班日志-20261001-120000-000.jsonl"]);
  // keepDays=1 时只留今天
  assert.deepEqual(selectExpiredLogNames(names, { now: T, keepDays: 1 }), [
    "值班日志-20261001-120000-000.jsonl",
    "值班日志-20261106-235959-999.jsonl",
  ]);
});
