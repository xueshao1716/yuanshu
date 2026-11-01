// 主动能力：预算、冷会话、抖动、免打扰（2026-11-02）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withJitter, readBudget, spendBudget, pickColdSession, isQuietHours, budgetFile } from "../../engine/proactive.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "proactive-"));

test("抖动：在 ±ratio 内，且不会负数", () => {
  assert.equal(withJitter(1000, { ratio: 0.05, rand: () => 0.5 }), 1000);
  assert.equal(withJitter(1000, { ratio: 0.1, rand: () => 1 }), 1100);
  assert.equal(withJitter(1000, { ratio: 0.1, rand: () => 0 }), 900);
  assert.equal(withJitter(0, { ratio: 0.1 }), 0);
});

test("预算：花到上限就拒绝，且落盘", () => {
  const root = ws();
  assert.equal(readBudget(root, "2026-11-02", { cap: 2 }).remaining, 2);
  assert.equal(spendBudget(root, "2026-11-02", { cap: 2 }).ok, true);
  assert.equal(spendBudget(root, "2026-11-02", { cap: 2 }).ok, true);
  const third = spendBudget(root, "2026-11-02", { cap: 2 });
  assert.equal(third.ok, false);
  assert.match(third.reason, /打扰够了/);
  assert.equal(readBudget(root, "2026-11-02", { cap: 2 }).used, 2);
  assert.ok(fs.existsSync(budgetFile(root)));
});

test("预算按天独立", () => {
  const root = ws();
  spendBudget(root, "2026-11-02", { cap: 1 });
  assert.equal(readBudget(root, "2026-11-03", { cap: 1 }).used, 0);
});

test("冷会话：只挑够久没动、名字不吵、不是当前会话的", () => {
  const now = Date.parse("2026-11-02T10:00:00");
  const sessions = [
    { id: "a", name: "改海报", updatedAt: new Date(now - 5 * 3600_000).toISOString() },
    { id: "b", name: "刚聊过", updatedAt: new Date(now - 10 * 60_000).toISOString() },
    { id: "c", name: "交付门验证", updatedAt: new Date(now - 9 * 3600_000).toISOString() },
    { id: "d", name: "当前会话", updatedAt: new Date(now - 8 * 3600_000).toISOString() },
  ];
  const hit = pickColdSession(sessions, { now, idleMs: 3 * 3600_000, skipId: "d" });
  assert.equal(hit.session.id, "a");
});

test("冷会话：没有够久的就返回 null", () => {
  const now = Date.now();
  const sessions = [{ id: "a", name: "刚聊过", updatedAt: new Date(now - 60_000).toISOString() }];
  assert.equal(pickColdSession(sessions, { now, idleMs: 3 * 3600_000 }), null);
});

test("免打扰：0–7 点是安静时段", () => {
  assert.equal(isQuietHours(new Date("2026-11-02T03:00:00").getTime()), true);
  assert.equal(isQuietHours(new Date("2026-11-02T10:00:00").getTime()), false);
});
