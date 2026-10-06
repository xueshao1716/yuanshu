import { test } from "node:test";
import assert from "node:assert/strict";
import { planSidebar, timeBucketOf, displayName } from "../../frontend/src/lib/session-sidebar.mjs";

const NOW = new Date(2026, 9, 6, 23, 0).getTime();
const at = (days, h = 12) => new Date(2026, 9, 6 - days, h).toISOString();

test("时间分段按本地日历日", () => {
  assert.equal(timeBucketOf(at(0, 0), NOW), "today");
  assert.equal(timeBucketOf(at(1, 23), NOW), "yesterday");
  assert.equal(timeBucketOf(at(6), NOW), "week");
  assert.equal(timeBucketOf(at(7), NOW), "month");
  assert.equal(timeBucketOf(at(29), NOW), "month");
  assert.equal(timeBucketOf(at(30), NOW), "older");
  assert.equal(timeBucketOf("bad", NOW), "older");
});

test("置顶单列；对话按时间分段；其余按组；空组不出", () => {
  const sessions = [
    { id: "a", name: "今天的", group: "workspace", updatedAt: at(0) },
    { id: "b", name: "置顶的", group: "workspace", updatedAt: at(40), pinned: true },
    { id: "c", name: "老的", group: "workspace", updatedAt: at(40) },
    { id: "d", name: "微信·o9cq80wXRB4", group: "wechat", updatedAt: at(0) },
    { id: "e", name: "终端", group: "terminal", updatedAt: at(2) },
  ];
  const plan = planSidebar(sessions, { now: NOW });
  assert.deepEqual(plan.map(s => s.key), ["pinned", "workspace", "wechat", "terminal"]);
  assert.deepEqual(plan[0].items.map(s => s.id), ["b"]);
  assert.deepEqual(plan[1].buckets.map(b => b.key), ["today", "older"]);
  assert.equal(plan[1].count, 2);
  assert.equal(displayName(sessions[3]), "联系人 o9cq80wX");
});

test("搜索同时匹配名字、预览和显示名", () => {
  const sessions = [
    { id: "a", name: "鹈鹕", group: "workspace", updatedAt: at(0), preview: "" },
    { id: "b", name: "x", group: "workspace", updatedAt: at(0), preview: "骑车的鹈鹕" },
    { id: "c", name: "微信·abc", group: "wechat", updatedAt: at(0) },
  ];
  assert.equal(planSidebar(sessions, { now: NOW, search: "鹈鹕" })[0].count, 2);
  assert.deepEqual(planSidebar(sessions, { now: NOW, search: "联系人" }).map(s => s.key), ["wechat"]);
});
