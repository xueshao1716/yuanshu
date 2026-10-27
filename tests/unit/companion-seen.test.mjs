// 微信活动要算「人在这儿」：单测
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCompanionStore } from "../../engine/companion-store.mjs";
import { shouldNudge } from "../../engine/companion-nudge.mjs";

const mk = () => createCompanionStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "companion-")) });

test("模拟：只在网页活动过 58 分钟 → 会推（复现用户遇到的情况）", () => {
  const store = mk();
  const t0 = Date.now();
  store.touchSeen({ throttleMs: 0 });         // 用户 58 分钟前在网页
  const seenAt = t0;
  const gate = shouldNudge({ now: t0 + 58 * 60_000, seenAt, nudgeAt: 0, dnd: false });
  assert.equal(gate.ok, true, "只看网页活动时确实会误推");
});

test("微信来消息后：seenAt 刷新 → 不再推", () => {
  const store = mk();
  store.touchSeen({ throttleMs: 0 });
  // 用户跑去微信聊天，中途消息触发 touchSeen（throttle 0 = 立即写）
  store.touchSeen({ throttleMs: 0 });
  const now = Date.now() + 30_000;
  const gate = shouldNudge({ now, seenAt: store.seen().seenAt, nudgeAt: 0, dnd: false });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "recently_seen");
});

test("touchSeen 关掉节流后能连续刷新（微信消息可能很密）", () => {
  const store = mk();
  const a = store.touchSeen({ throttleMs: 0 });
  const b = store.touchSeen({ throttleMs: 0 });
  assert.ok(b.seenAt >= a.seenAt);
});
