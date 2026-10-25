// 提炼成 claim + 按价值给寿命（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractClaims, durabilityOf, enrichEntry, renewOnUse, TTL_BY_DURABILITY, DAY } from "../../engine/knowledge-enrich.mjs";

test("决定类：活 90 天（这种才叫知识）", () => {
  const claims = extractClaims("我们商量后决定：以后都用 pnpm 装依赖，别再混用 npm。");
  const decision = claims.find((c) => c.type === "decision");
  assert.ok(decision, "应该抽到决定");
  assert.match(decision.value, /pnpm/);
  assert.equal(durabilityOf(claims), "long");
});

test("偏好与教训也能抽，且都算长期", () => {
  const c1 = extractClaims("我要求：报错的时候先说要我做什么，别只丢一段栈。");
  assert.ok(c1.some((c) => c.type === "preference" || c.type === "decision"));
  const c2 = extractClaims("教训：只用 execFileSync 的 stdout 会漏掉 ffmpeg 写在 stderr 的响度摘要。");
  assert.ok(c2.some((c) => c.type === "lesson"));
});

test("事实类（带数字/版本）→ 中期 30 天", () => {
  const claims = extractClaims("这版跑下来单条耗时中位 33 秒，最长 7169 秒。");
  assert.ok(claims.length > 0);
  assert.equal(durabilityOf(claims), "medium");
});

test("抽不出 claim 的碎话 → 短期（7 天），不硬编", () => {
  const claims = extractClaims("好了 ✅（命令跑完，输出 ok）");
  assert.equal(claims.length, 0);
  assert.equal(durabilityOf(claims), "short");
});

test("enrichEntry：写 claims/claimType/summary，并按类型设 expiresAt", () => {
  const now = Date.parse("2026-10-26T00:00:00Z");
  const e = enrichEntry({ text: "决定：以后交付前先跑 output_check。", createdAt: now }, { now });
  assert.equal(e.claimType, "decision");
  assert.ok(e.claimCount >= 1);
  assert.equal(e.durability, "long");
  assert.equal(e.expiresAt, now + TTL_BY_DURABILITY.long);
  assert.match(e.summary, /output_check/);
});

test("续命：被引用过就延长，不会 7 天自己消失", () => {
  const now = Date.parse("2026-10-26T00:00:00Z");
  const e = enrichEntry({ text: "事实：pip 缓存 1.1GB 在 D 盘。", createdAt: now }, { now });
  const renewed = renewOnUse(e, { now: now + 20 * DAY, uses: 3 });
  assert.ok(renewed.expiresAt > e.expiresAt);
  assert.equal(renewed.renewCount, 1);
  assert.equal(renewOnUse(e, { uses: 0 }).expiresAt, e.expiresAt, "没用过就不续");
});
