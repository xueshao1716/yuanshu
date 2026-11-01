// 自改触发（影子模式）：找短板 → 冷却 → 只记拟议，不改代码（2026-11-02）
import { test } from "node:test";
import assert from "node:assert/strict";
import { findWeakSpots, shouldPropose, makeShadowProposal } from "../../engine/self-change-trigger.mjs";

const now = Date.parse("2026-11-02T10:00:00");
const ev = (verdict, targetId, at = now - 3600_000, extra = {}) => ({ kind: "compare", target: "skill", targetId, verdict, at: new Date(at).toISOString(), ...extra });

test("失败不足 3 次不算短板", () => {
  assert.equal(findWeakSpots([ev("rollback", "py"), ev("rollback", "py")], { now }).length, 0);
});

test("同一目标 3 次失败 → 短板，带任务类型", () => {
  const spots = findWeakSpots([ev("rollback", "py"), ev("red", "py"), ev("rollback", "py", now - 7200_000, { taskType: "coding" })], { now });
  assert.equal(spots.length, 1);
  assert.equal(spots[0].targetId, "py");
  assert.equal(spots[0].fails, 3);
});

test("窗口外的事件不参与", () => {
  const old = now - 100 * 3600_000;
  assert.equal(findWeakSpots([ev("rollback", "py", old), ev("rollback", "py", old), ev("rollback", "py", old)], { now }).length, 0);
});

test("成功事件不算失败", () => {
  assert.equal(findWeakSpots([ev("keep", "py"), ev("green", "py"), ev("pass", "py")], { now }).length, 0);
});

test("冷却中不提", () => {
  const events = [ev("rollback", "py"), ev("rollback", "py"), ev("rollback", "py")];
  const out = shouldPropose({ events, lastByTarget: { "skill:py": now - 1000 }, now });
  assert.equal(out.should, false);
  assert.match(out.reason, /冷却/);
});

test("该提时给出短板与原因", () => {
  const events = [ev("rollback", "py"), ev("rollback", "py"), ev("rollback", "py")];
  const out = shouldPropose({ events, now });
  assert.equal(out.should, true);
  assert.equal(out.spot.targetId, "py");
  assert.match(out.reason, /失败 3 次/);
});

test("影子提案：标记 shadow/enabled=false，不含文件与分支", () => {
  const spot = { target: "skill", targetId: "py", fails: 4, taskTypes: ["coding"] };
  const p = makeShadowProposal(spot, { now });
  assert.equal(p.shadow, true);
  assert.equal(p.enabled, false);
  assert.equal(p.files, undefined);
  assert.equal(p.branch, undefined);
  assert.match(p.next, /validate/);
});
