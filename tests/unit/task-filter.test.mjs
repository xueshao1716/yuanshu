// 任务过滤：时间窗与关键词（2026-11-01）
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayWindow, withinDay, filterTasks } from "../../engine/task-filter.mjs";

const NOW = new Date("2026-11-01T12:00:00").getTime();
const iso = (ms) => new Date(ms).toISOString();
const tasks = [
  { id: "a", label: "自我反思", prompt: "每日复盘", lastRun: iso(NOW - 60_000) },
  { id: "b", label: "路由派活", prompt: "核对交付门", lastRun: iso(NOW - 3 * 86400000) },
  { id: "c", label: "旧任务", prompt: "很久以前", lastRun: iso(NOW - 40 * 86400000) },
  { id: "d", label: "没跑过", prompt: "x", lastRun: null },
];

test("dayWindow：今天/昨天/周/月/最近N天", () => {
  assert.deepEqual(dayWindow("today"), { kind: "today" });
  assert.deepEqual(dayWindow("yesterday"), { kind: "yesterday" });
  assert.deepEqual(dayWindow("week"), { kind: "days", days: 7 });
  assert.deepEqual(dayWindow("month"), { kind: "days", days: 30 });
  assert.deepEqual(dayWindow("recent3"), { kind: "days", days: 3 });
  assert.equal(dayWindow(""), null);
});

test("withinDay：今天的只认今天", () => {
  assert.equal(withinDay(iso(NOW - 1000), "today", NOW), true);
  assert.equal(withinDay(iso(NOW - 3 * 86400000), "today", NOW), false);
  assert.equal(withinDay(iso(NOW - 3 * 86400000), "week", NOW), true);
  assert.equal(withinDay(iso(NOW - 40 * 86400000), "month", NOW), false);
  assert.equal(withinDay(null, "today", NOW), false, "没跑过的任务不算今天");
});

test("filterTasks：时间 + 关键词", () => {
  assert.deepEqual(filterTasks(tasks, { day: "today", now: NOW }).map((t) => t.id), ["a"]);
  assert.deepEqual(filterTasks(tasks, { day: "week", now: NOW }).map((t) => t.id), ["a", "b"]);
  assert.deepEqual(filterTasks(tasks, { q: "交付门", now: NOW }).map((t) => t.id), ["b"]);
  assert.deepEqual(filterTasks(tasks, { day: "month", q: "复盘", now: NOW }).map((t) => t.id), ["a"]);
});

test("filterTasks：空条件返回全部", () => {
  assert.equal(filterTasks(tasks, { now: NOW }).length, 4);
});
