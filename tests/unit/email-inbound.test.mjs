// 邮件 → 入站事件：单测
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchNewMail } from "../../engine/email-bridge.mjs";

test("新邮件同时喂通知与入站事件", async () => {
  const notified = [];
  const events = [];
  await dispatchNewMail(
    { provider: "imap", account: "a@qq.com", from: "boss@x.com", subject: "明天交回执", snippet: "记得带", uid: "1" },
    { notifyFn: async (m) => notified.push(m), eventFn: (e) => events.push(e) },
  );
  assert.equal(notified.length, 1);
  assert.match(notified[0], /新邮件/);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "email");
  assert.equal(events[0].kind, "mail");
  assert.match(events[0].text, /boss@x\.com/);
  assert.match(events[0].text, /明天交回执/);
});

test("只有通知没有事件的旧用法仍然工作（不回归）", async () => {
  const notified = [];
  const r = await dispatchNewMail({ provider: "gmail", from: "x", subject: "s", snippet: "" }, { notifyFn: async (m) => notified.push(m), eventFn: null });
  assert.equal(r.ok, true);
  assert.equal(notified.length, 1);
  assert.match(notified[0], /Gmail/);
});

test("通知回调抛错不影响事件投递", async () => {
  const events = [];
  await dispatchNewMail(
    { provider: "outlook", from: "a", subject: "b", snippet: "c" },
    { notifyFn: async () => { throw new Error("boom") }, eventFn: (e) => events.push(e) },
  );
  assert.equal(events.length, 1, "通知失败不该挡住事件");
});
