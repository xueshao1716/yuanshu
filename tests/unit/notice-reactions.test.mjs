// 推送反应：统计与降频判断（2026-11-03）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordPush, recordReaction, reactionStats, shouldThrottle, readReactions } from "../../engine/notice-reactions.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "react-"));
const now = Date.now();
const at = (h) => new Date(now - h * 3600000).toISOString();

test("缺 key 拒绝", () => {
  assert.equal(recordPush(ws(), {}).ok, false);
  assert.equal(recordReaction(ws(), { key: "k", action: "瞎写" }).ok, false);
});

test("统计：发 3 看 1 忽略 1", () => {
  const root = ws();
  recordPush(root, { key: "a", kind: "done", at: at(3) });
  recordPush(root, { key: "b", kind: "done", at: at(2) });
  recordPush(root, { key: "c", kind: "done", at: at(1) });
  recordReaction(root, { key: "a", action: "open", at: at(2.5) });
  recordReaction(root, { key: "b", action: "ignore", at: at(1.5) });
  const s = reactionStats(root, { now });
  assert.equal(s[0].sent, 3);
  assert.equal(s[0].opened, 1);
  assert.equal(s[0].ignored, 1);
  assert.equal(s[0].pending, 1);
  assert.equal(s[0].engageRate, 0.33);
});

test("连续 3 条没看 → 建议降频", () => {
  const root = ws();
  for (const k of ["x1", "x2", "x3"]) recordPush(root, { key: k, kind: "away", at: at(1) });
  const r = shouldThrottle(root, "away", { threshold: 3 });
  assert.equal(r.throttle, true);
  assert.match(r.reason, /建议降频/);
});

test("有一条看了 → 不降频", () => {
  const root = ws();
  for (const k of ["y1", "y2", "y3"]) recordPush(root, { key: k, kind: "away", at: at(1) });
  recordReaction(root, { key: "y2", action: "open", at: at(0.5) });
  assert.equal(shouldThrottle(root, "away", { threshold: 3 }).throttle, false);
});

test("样本不足 → 不降频", () => {
  const root = ws();
  recordPush(root, { key: "z1", kind: "away", at: at(1) });
  const r = shouldThrottle(root, "away", { threshold: 3 });
  assert.equal(r.throttle, false);
  assert.match(r.reason, /样本不足/);
});

test("按类型分开统计", () => {
  const root = ws();
  recordPush(root, { key: "d1", kind: "done", at: at(1) });
  recordPush(root, { key: "aw1", kind: "away", at: at(1) });
  const s = reactionStats(root, { now });
  assert.equal(s.length, 2);
  assert.ok(s.some((x) => x.kind === "done"));
  assert.ok(s.some((x) => x.kind === "away"));
});
