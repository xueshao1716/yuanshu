import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const inboxMod = () => import("../../engine/thread-inbox.mjs");
const deliveryMod = () => import("../../engine/thread-delivery.mjs");
const routerMod = () => import("../../engine/thread-router.mjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ys-thread-"));

test("收件箱：入队、计数、查看，文件按话题隔离", async () => {
  const { enqueue, size, peek } = await inboxMod();
  const ws = tmp();
  assert.equal(enqueue(ws, "wechat:g1", { source: "wechat", text: "第一条" }), 1);
  assert.equal(enqueue(ws, "wechat:g1", { source: "wechat", text: "第二条" }), 2);
  assert.equal(enqueue(ws, "task:t1", { source: "task", text: "另一个话题" }), 1);
  assert.equal(size(ws, "wechat:g1"), 2);
  assert.equal(size(ws, "task:t1"), 1);
  const rows = peek(ws, "wechat:g1");
  assert.deepEqual(rows.map((r) => r.text), ["第一条", "第二条"]);
});

test("收件箱：drain 取走并清空，再取为空", async () => {
  const { enqueue, drain, size } = await inboxMod();
  const ws = tmp();
  enqueue(ws, "wechat:g2", { text: "a" });
  enqueue(ws, "wechat:g2", { text: "b" });
  const taken = drain(ws, "wechat:g2");
  assert.deepEqual(taken.map((r) => r.text), ["a", "b"]);
  assert.equal(size(ws, "wechat:g2"), 0);
  assert.deepEqual(drain(ws, "wechat:g2"), []);
});

test("收件箱：drain 可只取一部分，剩下的留着", async () => {
  const { enqueue, drain, size } = await inboxMod();
  const ws = tmp();
  for (const t of ["1", "2", "3"]) enqueue(ws, "run:r1", { text: t });
  const first = drain(ws, "run:r1", { limit: 2 });
  assert.deepEqual(first.map((r) => r.text), ["1", "2"]);
  assert.equal(size(ws, "run:r1"), 1);
});

test("收件箱：空键不写盘；单话题超上限丢最旧的", async () => {
  const { enqueue, size, peek } = await inboxMod();
  const ws = tmp();
  assert.equal(enqueue(ws, "", { text: "x" }), 0);
  for (let i = 0; i < 205; i += 1) enqueue(ws, "task:cap", { text: `m${i}` });
  assert.equal(size(ws, "task:cap"), 200);
  const rows = peek(ws, "task:cap", { limit: 1 });
  assert.equal(rows[0].text, "m204");
});

test("直通判定：有订阅才 direct；微信话题默认不闷声直通", async () => {
  const { planDelivery } = await deliveryMod();
  const { subscribe, resetSubscriptions } = await routerMod();
  resetSubscriptions();
  assert.equal(planDelivery({ taskId: "t0" }).mode, "main");

  subscribe("task:t0", { workerId: "w1" });
  const plan = planDelivery({ taskId: "t0" });
  assert.equal(plan.mode, "direct");
  assert.equal(plan.threadKey, "task:t0");

  // 微信：订阅了也不闷声吞（那边有人在等回话）
  subscribe("wechat:g9", { workerId: "w1" });
  const wx = planDelivery({ chatId: "g9" });
  assert.equal(wx.mode, "main");
  assert.match(wx.reason, /需要回话/);
  // 显式开门才放行
  assert.equal(planDelivery({ chatId: "g9" }, { allowWechat: true }).mode, "direct");
});

test("可闷声直通的话题白名单：task/run/mail 行，wechat 看开关，其它一律不行", async () => {
  const { canDirectSilently } = await deliveryMod();
  for (const k of ["task:t1", "run:r1", "mail:m1"]) assert.equal(canDirectSilently(k), true, k);
  assert.equal(canDirectSilently("wechat:g1"), false);
  assert.equal(canDirectSilently("wechat:g1", { allowWechat: true }), true);
  assert.equal(canDirectSilently("gh:pr#1"), false);
  assert.equal(canDirectSilently(""), false);
});

test("直通投递：direct 进收件箱，main 什么都不写", async () => {
  const { acceptDirect } = await deliveryMod();
  const { subscribe, resetSubscriptions } = await routerMod();
  const { size } = await inboxMod();
  const ws = tmp();
  resetSubscriptions();
  subscribe("task:t7", { workerId: "w" });

  const main = acceptDirect(ws, { chatId: "no-sub", text: "路人" });
  assert.equal(main.ok, false);
  assert.equal(size(ws, "wechat:no-sub"), 0);

  const direct = acceptDirect(ws, { taskId: "t7", text: "同一件事的新进展" });
  assert.equal(direct.ok, true);
  assert.equal(direct.queued, 1);
  assert.equal(size(ws, "task:t7"), 1);
});

test("合并消费：takePendingBlock 取走并生成可注入段落，空则返回空串", async () => {
  const { acceptDirect, takePendingBlock } = await deliveryMod();
  const { subscribe, resetSubscriptions } = await routerMod();
  const ws = tmp();
  resetSubscriptions();
  subscribe("mail:m1", { workerId: "w" });

  assert.deepEqual(takePendingBlock(ws, "mail:m1"), { count: 0, text: "" });

  acceptDirect(ws, { mailThreadId: "m1", source: "email", text: "客户改了口径：只统计昨天的" });
  acceptDirect(ws, { mailThreadId: "m1", source: "email", text: "另外附件换成 v2" });
  const block = takePendingBlock(ws, "mail:m1");
  assert.equal(block.count, 2);
  assert.match(block.text, /积压的 2 条后续/);
  assert.match(block.text, /只统计昨天的/);
  assert.match(block.text, /附件换成 v2/);
  // 取走之后不留残影，避免下一轮重复注入
  assert.equal(takePendingBlock(ws, "mail:m1").count, 0);
});

test("pendingCount：按事件推话题键，没有键返回 0", async () => {
  const { acceptDirect, pendingCount } = await deliveryMod();
  const { subscribe, resetSubscriptions } = await routerMod();
  const ws = tmp();
  resetSubscriptions();
  subscribe("run:r5", { workerId: "w" });
  acceptDirect(ws, { runId: "r5", text: "跑起来之后的新事件" });
  assert.equal(pendingCount(ws, { runId: "r5" }), 1);
  assert.equal(pendingCount(ws, { text: "没有话题键" }), 0);
});

test("派活标签：话题键编进 label 并能原样取回，普通任务不受影响", async () => {
  const { taskLabelFor, threadKeyOfLabel, ROUTER_LABEL_PREFIX } = await deliveryMod();
  assert.equal(taskLabelFor("wechat:g1"), `${ROUTER_LABEL_PREFIX}wechat:g1`);
  assert.equal(threadKeyOfLabel(taskLabelFor("wechat:g1")), "wechat:g1");
  assert.equal(threadKeyOfLabel(taskLabelFor("task:t1")), "task:t1");
  // 没有话题键：退回固定标签，取回来是空串（不会误认成话题）
  assert.equal(taskLabelFor(""), "路由派活");
  assert.equal(threadKeyOfLabel("路由派活"), "");
  // 别人起的任务（定时复盘/做梦）不能被抓成派活
  assert.equal(threadKeyOfLabel("每日自我反思"), "");
  assert.equal(threadKeyOfLabel(""), "");
});
