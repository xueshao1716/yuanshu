// 值班程序判定层（纯函数）：cmd 退出码/正则、http 状态码/关键字、file 变化、time 到点，以及限流归一与命令闸门。
// 这一层没有模型、没有 IO —— 未命中时零模型调用的成本结构就落在这些纯函数上。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeCmd, judgeHttp, judgeFile, judgeTime,
  normalizeSpec, clampLimits, preflightCommand,
  MIN_INTERVAL_MS, DEFAULT_DAILY_CAP, MAX_ACTIVE_WATCHES,
} from "../../engine/watch-duty.mjs";

test("cmd：退出码、输出子串、输出正则、超时/被拒都不算命中", () => {
  assert.equal(judgeCmd({ expectExit: 0 }, { exitCode: 0 }).hit, true);
  assert.equal(judgeCmd({ expectExit: 0 }, { exitCode: 1 }).hit, false);
  assert.equal(judgeCmd({ expectExit: [0, 2] }, { exitCode: 2 }).hit, true);
  assert.equal(judgeCmd({ expectExit: 0, stdoutIncludes: "FAIL" }, { exitCode: 0, stdout: "2 FAIL" }).hit, true);
  assert.equal(judgeCmd({ expectExit: 0, stdoutIncludes: "FAIL" }, { exitCode: 1, stdout: "FAIL" }).hit, false, "退出码不对就不算命中");
  assert.equal(judgeCmd({ expectExit: 0, stdoutIncludes: "FAIL" }, { exitCode: 0, stdout: "all good" }).hit, false);
  assert.equal(judgeCmd({ expectExit: 0, stdoutRegex: "FAIL\\s+\\d+" }, { exitCode: 0, stdout: "FAIL 3" }).hit, true);
  assert.equal(judgeCmd({ expectExit: 0, stdoutRegex: "FAIL\\s+\\d+" }, { exitCode: 0, stdout: "FAIL" }).hit, false);
  assert.equal(judgeCmd({ expectExit: 0 }, { timedOut: true }).hit, false);
  const blocked = judgeCmd({ expectExit: 0 }, { blocked: true, error: "命中宪法红线 [no-force-git]" });
  assert.equal(blocked.hit, false);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /红线/);
});

test("http：状态码 + 正文关键字（含 notContains）", () => {
  assert.equal(judgeHttp({ expectStatus: 200, contains: "宕机" }, { status: 200, body: "服务宕机中" }).hit, true);
  assert.equal(judgeHttp({ expectStatus: 200 }, { status: 500, body: "" }).hit, false);
  assert.equal(judgeHttp({ expectStatus: [200, 201] }, { status: 201, body: "" }).hit, true);
  assert.equal(judgeHttp({ expectStatus: 200, contains: "成功" }, { status: 200, body: "失败了" }).hit, false);
  assert.equal(judgeHttp({ expectStatus: 200, notContains: "正常" }, { status: 200, body: "一切正常" }).hit, false);
  assert.equal(judgeHttp({ expectStatus: 200 }, { error: "ECONNREFUSED" }).hit, false);
});

test("file：首次只建基线；变化/出现/消失/关键字/大小各按规则判定", () => {
  const prev = { exists: true, mtimeMs: 100, size: 10 };
  // 首次观察：不触发
  const first = judgeFile({ mode: "changed" }, { exists: true, mtimeMs: 100, size: 10 }, null);
  assert.equal(first.hit, false);
  assert.equal(first.baseline, true);
  // mtime / 大小变化
  assert.equal(judgeFile({ mode: "changed" }, { exists: true, mtimeMs: 101, size: 10 }, prev).hit, true);
  assert.equal(judgeFile({ mode: "changed" }, { exists: true, mtimeMs: 100, size: 11 }, prev).hit, true);
  assert.equal(judgeFile({ mode: "changed" }, { exists: true, mtimeMs: 100, size: 10 }, prev).hit, false);
  // 出现 / 消失
  assert.equal(judgeFile({ mode: "appeared" }, { exists: true, mtimeMs: 1, size: 1 }, { exists: false }).hit, true);
  assert.equal(judgeFile({ mode: "appeared" }, { exists: true, mtimeMs: 1, size: 1 }, { exists: true }).hit, false);
  assert.equal(judgeFile({ mode: "disappeared" }, { exists: false }, { exists: true }).hit, true);
  assert.equal(judgeFile({ mode: "disappeared" }, { exists: true, mtimeMs: 1, size: 1 }, { exists: true }).hit, false);
  // 关键字 / 大小阈值（绝对条件，不需要基线）
  assert.equal(judgeFile({ mode: "contains", contains: "ERROR" }, { exists: true, content: "x ERROR y" }).hit, true);
  assert.equal(judgeFile({ mode: "contains", contains: "ERROR" }, { exists: true, content: "x ok y" }).hit, false);
  assert.equal(judgeFile({ mode: "size_gt", sizeGt: 100 }, { exists: true, size: 101 }).hit, true);
  assert.equal(judgeFile({ mode: "size_gt", sizeGt: 100 }, { exists: true, size: 100 }).hit, false);
  assert.equal(judgeFile({ mode: "changed" }, { exists: false }, { exists: true }).hit, true, "消失也算变化");
});

test("time：到点语义复用 time-engine（daily/weekly/once + 当天新建不补跑）", () => {
  const slot = new Date(2026, 10, 7, 9, 0, 0).getTime(); // 本地 09:00
  const createdAt = new Date(2026, 10, 1, 8, 0, 0).getTime();
  assert.equal(judgeTime({ type: "daily", at: "09:00" }, { now: slot, createdAt }).hit, true);
  assert.equal(judgeTime({ type: "daily", at: "09:01" }, { now: slot, createdAt }).hit, false);
  assert.equal(judgeTime({ type: "daily", at: "09:00" }, { now: slot, createdAt, lastFiredAt: slot }).hit, false, "当天已经触发过就不再触发");
  assert.equal(judgeTime({ type: "daily", at: "09:00" }, { now: slot + 86400000, createdAt, lastFiredAt: slot }).hit, true, "第二天照常");
  // once：只在指定日期、且只触发一次
  assert.equal(judgeTime({ type: "once", at: "09:00", date: "2026-11-07" }, { now: slot, createdAt }).hit, true);
  assert.equal(judgeTime({ type: "once", at: "09:00", date: "2026-11-07" }, { now: slot, createdAt, lastFiredAt: slot }).hit, false);
  assert.equal(judgeTime({ type: "once", at: "09:00", date: "2026-11-08" }, { now: slot, createdAt }).hit, false);
  // weekly：按本地星期几
  const dow = new Date(2026, 10, 7).getDay() || 7;
  assert.equal(judgeTime({ type: "weekly", at: "09:00", day: dow }, { now: slot, createdAt }).hit, true);
  assert.equal(judgeTime({ type: "weekly", at: "09:00", day: (dow % 7) + 1 }, { now: slot, createdAt }).hit, false);
  // 当天 10:00 才建、at=09:00：不补跑（与 time-engine 一致）
  const late = new Date(2026, 10, 7, 10, 0, 0).getTime();
  assert.equal(judgeTime({ type: "daily", at: "09:00" }, { now: slot, createdAt: late }).hit, false);
});

test("限流归一：intervalMs 下限 60 秒、dailyCap 默认 12、活跃上限 10", () => {
  assert.equal(clampLimits({ intervalMs: 1000 }).intervalMs, MIN_INTERVAL_MS);
  assert.equal(clampLimits({ intervalSec: 120 }).intervalMs, 120000);
  assert.equal(clampLimits({}).dailyCap, DEFAULT_DAILY_CAP);
  assert.equal(clampLimits({ dailyCap: 9999 }).dailyCap, 100);
  assert.ok(clampLimits({ intervalMs: 1000 }).notes.length, "被夹紧要说出来");
  assert.equal(MAX_ACTIVE_WATCHES, 10);
});

test("spec 校验：四种 kind 的必填项与坏值都给出中文原因", () => {
  assert.equal(normalizeSpec("cmd", {}).ok, false);
  assert.match(normalizeSpec("cmd", { command: "x", stdoutRegex: "([" }).error, /正则/);
  assert.equal(normalizeSpec("cmd", { command: "git status" }).spec.expectExit[0], 0);
  assert.equal(normalizeSpec("http", { url: "ftp://x" }).ok, false);
  assert.equal(normalizeSpec("http", { url: "https://x", expectStatus: 500 }).spec.expectStatus[0], 500);
  assert.equal(normalizeSpec("file", { path: "a", mode: "contains" }).ok, false);
  assert.equal(normalizeSpec("file", { path: "a", mode: "size_gt" }).ok, false);
  assert.equal(normalizeSpec("file", { path: "a" }).spec.mode, "changed");
  assert.equal(normalizeSpec("time", { type: "weekly", at: "09:00" }).ok, false);
  assert.equal(normalizeSpec("time", { type: "once", at: "09:00" }).ok, false);
  assert.equal(normalizeSpec("time", { type: "daily", at: "9:00" }).ok, false);
  assert.equal(normalizeSpec("time", { type: "daily", at: "09:00" }).spec.type, "daily");
  assert.equal(normalizeSpec("nope", {}).ok, false);
});

test("命令闸门：宪法 deny 优先，其次危险命令；正常只读命令放行", () => {
  const forcePush = preflightCommand("git push --force origin main");
  assert.equal(forcePush.ok, false);
  assert.equal(forcePush.rule, "no-force-git", "deny 规则先于沙箱判定");
  const rm = preflightCommand("rm -rf /tmp/whatever");
  assert.equal(rm.ok, false);
  assert.equal(rm.rule, "dangerous-cmd");
  const tunnel = preflightCommand("cloudflared tunnel --url http://127.0.0.1:8787");
  assert.equal(tunnel.ok, false);
  assert.equal(tunnel.rule, "no-tunnel");
  assert.equal(preflightCommand("git status --porcelain").ok, true);
});
