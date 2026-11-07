import { test } from "node:test";
import assert from "node:assert/strict";

const mod = () => import("../../engine/thread-router.mjs");

test("线程键：同一条话题的事件归到同一个键，无话题的留空", async () => {
  const { threadKeyOf } = await mod();
  assert.equal(threadKeyOf({ chatId: "wx-group-1" }), "wechat:wx-group-1");
  assert.equal(threadKeyOf({ taskId: "t1" }), "task:t1");
  assert.equal(threadKeyOf({ runId: "r1" }), "run:r1");
  assert.equal(threadKeyOf({ mailThreadId: "m1" }), "mail:m1");
  assert.equal(threadKeyOf({ threadId: "gh:pr#12" }), "gh:pr#12");
  assert.equal(threadKeyOf({}), "");
  assert.equal(threadKeyOf(null), "");
});

test("没有订阅 → 走主会话；订阅之后 → 直通", async () => {
  const { route, subscribe, resetSubscriptions } = await mod();
  resetSubscriptions();
  const ev = { chatId: "g1", text: "在吗" };
  assert.equal(route(ev).route, "main");

  subscribe("wechat:g1", { workerId: "w1", sessionId: "s1" });
  const r = route(ev);
  assert.equal(r.route, "direct");
  assert.equal(r.threadKey, "wechat:g1");
  assert.deepEqual(r.targets.map(t => t.workerId), ["w1"]);
});

test("多对多：同一线程可被多个 worker 订阅，一个 worker 也可订多条线程", async () => {
  const { route, subscribe, resetSubscriptions } = await mod();
  resetSubscriptions();
  subscribe("task:t9", { workerId: "a" });
  subscribe("task:t9", { workerId: "b" });
  subscribe("wechat:g2", { workerId: "a" });

  assert.deepEqual(route({ taskId: "t9" }).targets.map(t => t.workerId).sort(), ["a", "b"]);
  assert.deepEqual(route({ chatId: "g2" }).targets.map(t => t.workerId), ["a"]);
  assert.equal(route({ chatId: "g3" }).route, "main");
});

test("退订之后回到主会话", async () => {
  const { route, subscribe, unsubscribe, resetSubscriptions } = await mod();
  resetSubscriptions();
  subscribe("run:r2", { workerId: "w" });
  assert.equal(route({ runId: "r2" }).route, "direct");
  assert.equal(unsubscribe("run:r2", "w"), true);
  assert.equal(route({ runId: "r2" }).route, "main");
});

test("重复订阅不会重复计数入口，但事件计数累加", async () => {
  const { subscribe, subscribersOf, resetSubscriptions } = await mod();
  resetSubscriptions();
  subscribe("task:t1", { workerId: "w" });
  const s2 = subscribe("task:t1", { workerId: "w" });
  assert.equal(subscribersOf("task:t1").length, 1);
  assert.equal(s2.count, 2);
});

test("空键或没有 workerId 不登记", async () => {
  const { subscribe, snapshot, resetSubscriptions } = await mod();
  resetSubscriptions();
  assert.equal(subscribe("", { workerId: "w" }), null);
  assert.equal(subscribe("task:x", {}), null);
  assert.equal(snapshot().length, 0);
});
