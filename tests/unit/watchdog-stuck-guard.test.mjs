// 守护判死：阈值单源 + 有活动轮次时缓杀。
// 背景：2026-10-25 用户收到的通知说"持续 180 秒会被守护重启"，而 watchdog 实际是 300 秒
// （10-23 因 163 秒停顿会自愈而放宽）——通知和阈值是两份拷贝。这里钉住"只有一个源"，
// 以及"有对话在跑就别急着杀进程"。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LIMITS, decideStuckKill } = require("../../lib/watchdog-limits.cjs");

const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("阈值只有一份：watchdog 与 server 都从 lib/watchdog-limits.cjs 取", () => {
  assert.equal(LIMITS.STUCK_MIN_MS, 300_000, "10-23 起是 300 秒（180 会误杀 163 秒的自愈停顿）");
  const wd = src("../../watchdog.cjs");
  assert.match(wd, /require\("\.\/lib\/watchdog-limits\.cjs"\)/, "watchdog 要 require 共享阈值");
  assert.ok(!/const STUCK_MIN_MS = \d/.test(wd), "watchdog 里不许再留一份硬编码阈值");
  const srv = src("../../server.mjs");
  assert.match(srv, /import watchdogLimits from "\.\/lib\/watchdog-limits\.cjs"/, "server 也要读同一个源");
  // 通知文案里不许再出现写死的秒数
  assert.ok(!/持续 \d+ 秒会被守护重启/.test(srv), "卡顿通知不能再硬编码秒数");
  assert.match(srv, /WATCHDOG_LIMITS\.STUCK_MIN_MS/, "通知要用共享常量算秒数");
});

test("常规僵死：连挂 3 次且持续够久 → 杀", () => {
  const now = 1_000_000_000;
  const v = decideStuckKill({ consecutiveFails: 3, firstFailAt: now - 310_000, childStartedAt: now - 900_000, now });
  assert.equal(v.kill, true);
  assert.equal(v.deferred, false);
  assert.match(v.reason, /持续 310s|已持续 310s/);
});

test("失败次数/时长/启动宽限任一没到 → 不杀", () => {
  const now = 1_000_000_000;
  assert.equal(decideStuckKill({ consecutiveFails: 2, firstFailAt: now - 999_000, childStartedAt: now - 999_000, now }).kill, false);
  assert.equal(decideStuckKill({ consecutiveFails: 5, firstFailAt: now - 100_000, childStartedAt: now - 999_000, now }).kill, false);
  assert.equal(decideStuckKill({ consecutiveFails: 5, firstFailAt: now - 400_000, childStartedAt: now - 60_000, now }).kill, false, "冷启动 60 秒不能被判死");
});

test("有轮次在跑（冻住前心跳可见）→ 缓杀一个 ACTIVE_RUN_GRACE_MS", () => {
  const now = 1_000_000_000;
  const firstFailAt = now - 310_000;
  const v = decideStuckKill({
    consecutiveFails: 4, firstFailAt, childStartedAt: now - 900_000, now,
    activeRuns: 2, heartbeatAt: firstFailAt - 3_000,   // 冻住前 3 秒还写着 2 个轮次
  });
  assert.equal(v.kill, false, "正在跑对话时不该立刻杀");
  assert.equal(v.deferred, true);
  assert.match(v.reason, /2 个轮次/);
});

test("缓杀有上限：超了总容忍（300s + 300s）仍然杀，真死也收", () => {
  const now = 1_000_000_000;
  const firstFailAt = now - 610_000;
  const v = decideStuckKill({
    consecutiveFails: 9, firstFailAt, childStartedAt: now - 9_000_000, now,
    activeRuns: 1, heartbeatAt: firstFailAt - 1_000,
  });
  assert.equal(v.kill, true, "600 秒后就算有活动也要收");
});

test("心跳过时（冻住前很久没写）不能当活动证据", () => {
  const now = 1_000_000_000;
  const firstFailAt = now - 310_000;
  const v = decideStuckKill({
    consecutiveFails: 4, firstFailAt, childStartedAt: now - 900_000, now,
    activeRuns: 1, heartbeatAt: firstFailAt - 10 * 60_000,   // 10 分钟前的心跳，早就不可信
  });
  assert.equal(v.kill, true, "过时心跳不算数，避免拿一条陈旧记录无限缓杀");
});
