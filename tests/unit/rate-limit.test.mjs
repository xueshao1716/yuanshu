// engine/rate-limit.mjs 单测（2026-11-13）：8 条，覆盖用户要的 8 个行为。
// 全程注入时钟，不 sleep；限流日志写到临时目录，不碰真实工作区。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createRateLimiter,
  classifyRoute,
  isLoopbackAddress,
  normalizeRateLimitConfig,
  HIT_LOG_MAX_LINES,
  HIT_LOG_TRIM_TO,
  RATE_LIMIT_HIT_LOG_REL,
} from "../../engine/rate-limit.mjs";

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, at: () => t };
}

const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-rate-"));
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

test("令牌桶：/api/chat 20/分钟耗尽后拒绝，retryAfter 是补 1 个令牌的时间（3s）", () => {
  const clock = makeClock(0);
  const rl = createRateLimiter({ config: {}, now: clock.now, logHits: false });
  for (let i = 0; i < 20; i++) assert.equal(rl.check("203.0.113.7", "/api/chat").ok, true, `第 ${i + 1} 次应放行`);
  const blocked = rl.check("203.0.113.7", "/api/chat");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.category, "chat");
  assert.equal(blocked.reason, "route_budget");
  assert.equal(blocked.retryAfter, 3); // 60000ms / 20 = 3000ms
  // 同一 IP 的其它类别是独立桶：/api/system/doctor 还有 120/分钟
  assert.equal(rl.check("203.0.113.7", "/api/system/doctor").ok, true);
  // 补令牌后恢复：3 秒正好 1 个
  clock.advance(3000);
  assert.equal(rl.check("203.0.113.7", "/api/chat").ok, true);
});

test("按 IP 隔离：A 打满不影响 B，A 的 chat 打满不影响 A 的 stream", () => {
  const clock = makeClock(0);
  const rl = createRateLimiter({ config: {}, now: clock.now, logHits: false });
  for (let i = 0; i < 20; i++) rl.check("198.51.100.1", "/api/chat");
  assert.equal(rl.check("198.51.100.1", "/api/chat").ok, false);
  assert.equal(rl.check("198.51.100.2", "/api/chat").ok, true, "另一个 IP 应独立计数");
  for (let i = 0; i < 10; i++) assert.equal(rl.check("198.51.100.1", "/api/notify/stream").ok, true);
  assert.equal(rl.check("198.51.100.1", "/api/notify/stream").ok, false, "stream 独立 10/分钟");
});

test("回环豁免：127.0.0.1 / ::1 不限流也不锁；exemptLoopback:false 时一视同仁", () => {
  const clock = makeClock(0);
  const rl = createRateLimiter({ config: {}, now: clock.now, logHits: false });
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("8.8.8.8"), false);
  for (let i = 0; i < 100; i++) assert.equal(rl.check("127.0.0.1", "/api/chat").ok, true);
  for (let i = 0; i < 100; i++) assert.equal(rl.check("::1", "/api/chat").ok, true);
  for (let i = 0; i < 10; i++) assert.equal(rl.chargeAuthFailure("127.0.0.1", "/api/x", "GET").locked, false);
  assert.equal(rl.preAuth("::1", { credential: false }).ok, true);

  const strict = createRateLimiter({ config: { exemptLoopback: false }, now: clock.now, logHits: false });
  for (let i = 0; i < 20; i++) strict.check("127.0.0.1", "/api/chat");
  assert.equal(strict.check("127.0.0.1", "/api/chat").ok, false, "关掉豁免后回环也要限流");
});

test("失败锁定：同一 IP 错 5 次锁 15 分钟，preAuth 直接 429，到期自动解", () => {
  const clock = makeClock(0);
  const rl = createRateLimiter({ config: {}, now: clock.now, logHits: false });
  for (let i = 0; i < 4; i++) {
    const r = rl.chargeAuthFailure("198.51.100.9", "/api/system/x", "GET");
    assert.equal(r.locked, false);
    assert.equal(r.remainingAttempts, 4 - i);
  }
  const fifth = rl.chargeAuthFailure("198.51.100.9", "/api/system/x", "GET");
  assert.equal(fifth.locked, true);
  assert.equal(fifth.retryAfter, 900);

  // 锁定期内即使带了凭据也先回 429（preAuth 在 checkAuth 之前）
  const locked = rl.preAuth("198.51.100.9", { credential: true, pathname: "/api/chat" });
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, "auth_locked");
  assert.equal(locked.retryAfter, 900);

  clock.advance(899000);
  assert.equal(rl.preAuth("198.51.100.9", { credential: true }).ok, false);
  clock.advance(2000); // 15 分钟到期
  assert.equal(rl.preAuth("198.51.100.9", { credential: true }).ok, true);
  assert.equal(rl.chargeAuthFailure("198.51.100.9", "/api/x", "GET").locked, false, "解锁后重新从 1 计数");
});

test("成功解锁：失败 4 次后鉴权成功清零，再错 4 次仍不锁", () => {
  const clock = makeClock(0);
  const rl = createRateLimiter({ config: {}, now: clock.now, logHits: false });
  for (let i = 0; i < 4; i++) rl.chargeAuthFailure("192.0.2.5", "/api/x", "GET");
  rl.authSuccess("192.0.2.5");
  for (let i = 0; i < 4; i++) {
    assert.equal(rl.chargeAuthFailure("192.0.2.5", "/api/x", "GET").locked, false);
  }
  const fifth = rl.chargeAuthFailure("192.0.2.5", "/api/x", "GET");
  assert.equal(fifth.locked, true, "清零后第 5 次才锁");
});

test("enabled:false：一键关掉限流、锁定与日志", () => {
  const root = mkRoot();
  const logFile = path.join(root, "限流命中.jsonl");
  const clock = makeClock(0);
  const rl = createRateLimiter({ config: { enabled: false }, now: clock.now, hitLogFile: logFile });
  assert.equal(rl.enabled, false);
  for (let i = 0; i < 200; i++) assert.equal(rl.check("203.0.113.50", "/api/chat").ok, true);
  for (let i = 0; i < 20; i++) assert.equal(rl.chargeAuthFailure("203.0.113.50", "/api/x", "GET").locked, false);
  assert.equal(rl.preAuth("203.0.113.50", {}).ok, true);
  assert.equal(fs.existsSync(logFile), false, "关掉后不写命中日志");
});

test("预认证预算独立：无凭据 30/分钟，带凭据不扣，且不占路由桶", () => {
  const clock = makeClock(0);
  const rl = createRateLimiter({ config: {}, now: clock.now, logHits: false });
  const ip = "203.0.113.66";
  for (let i = 0; i < 30; i++) assert.equal(rl.preAuth(ip, { credential: false, pathname: "/api/x" }).ok, true);
  const over = rl.preAuth(ip, { credential: false, pathname: "/api/x" });
  assert.equal(over.ok, false);
  assert.equal(over.reason, "preauth_budget");
  assert.equal(over.retryAfter, 2); // 60000ms / 30 = 2000ms
  // 预认证预算不消耗 /api/chat 的桶
  assert.equal(rl.check(ip, "/api/chat").ok, true);
  // 带凭据的请求不占预认证预算（第 31 个带凭据请求仍放行）
  assert.equal(rl.preAuth(ip, { credential: true, pathname: "/api/x" }).ok, true);
  clock.advance(60000);
  assert.equal(rl.preAuth(ip, { credential: false, pathname: "/api/x" }).ok, true, "1 分钟后预算回满");
});

test("Retry-After 正确 + 命中日志字段/行数上限", () => {
  const root = mkRoot();
  const logFile = path.join(root, RATE_LIMIT_HIT_LOG_REL);
  const clock = makeClock(0);
  const rl = createRateLimiter({ config: {}, now: clock.now, hitLogFile: logFile });
  for (let i = 0; i < 10; i++) rl.check("203.0.113.80", "/api/sessions/x/stream");
  const stream = rl.check("203.0.113.80", "/api/sessions/x/stream");
  assert.equal(stream.ok, false);
  assert.equal(stream.category, "stream");
  assert.equal(stream.retryAfter, 6); // 60000ms / 10 = 6000ms

  const rows = readJsonl(logFile);
  assert.equal(rows.length >= 1, true);
  const last = rows.at(-1);
  assert.equal(last.reason, "route_budget");
  assert.equal(last.category, "stream");
  assert.equal(last.retryAfter, 6);
  assert.equal(last.limit, 10);
  assert.equal(last.path, "/api/sessions/x/stream");
  assert.equal(typeof last.at, "string");
  assert.equal(Number.isNaN(Date.parse(last.at)), false);

  // 行数上限：先塞 2005 行，再打一次命中 → 触发裁剪到 1800 行
  const seed = Array.from({ length: 2005 }, (_, i) => JSON.stringify({ at: new Date(0).toISOString(), ip: `10.0.0.${i % 255}`, path: "/seed" }));
  fs.writeFileSync(logFile, `${seed.join("\n")}\n`, "utf8");
  const rl2 = createRateLimiter({ config: {}, now: clock.now, hitLogFile: logFile });
  for (let i = 0; i < 5; i++) rl2.chargeAuthFailure("203.0.113.81", "/api/x", "GET"); // 第 5 次上锁并写日志
  const after = readJsonl(logFile);
  assert.equal(after.length, HIT_LOG_TRIM_TO, `应裁剪到 ${HIT_LOG_TRIM_TO} 行`);
  assert.equal(after.length <= HIT_LOG_MAX_LINES, true);
  assert.equal(after.at(-1).path, "/api/x");
});

test("配置归一与路由分类：坏值回默认，/stream 优先于 chat，非 /api 不限流", () => {
  const cfg = normalizeRateLimitConfig({ routes: { chat: { limit: -3, windowMs: "bad" } }, lockout: { failures: 9999 } });
  assert.equal(cfg.routes.chat.limit, 20);
  assert.equal(cfg.routes.chat.windowMs, 60000);
  assert.equal(cfg.lockout.failures, 1000);
  assert.equal(cfg.lockout.lockMs, 900000);
  assert.equal(classifyRoute("/api/chat"), "chat");
  assert.equal(classifyRoute("/api/chat/stream"), "stream");
  assert.equal(classifyRoute("/api/notify/stream"), "stream");
  assert.equal(classifyRoute("/api/sessions/abc/stream"), "stream");
  assert.equal(classifyRoute("/api/system/doctor"), "api");
  assert.equal(classifyRoute("/assets/app.js"), null);
  assert.equal(classifyRoute("/"), null);
});
