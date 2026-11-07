import { test } from "node:test";
import assert from "node:assert/strict";

const mod = () => import("../../engine/thread-relay.mjs");

test("话题键 → 回话目标：wechat/mail 认得出，其余给空通道", async () => {
  const { relayTargetOf } = await mod();
  assert.deepEqual(relayTargetOf("wechat:wx-group-1"), { channel: "wechat", to: "wx-group-1" });
  assert.deepEqual(relayTargetOf("mail:abc"), { channel: "mail", to: "abc" });
  assert.equal(relayTargetOf("task:t1").channel, "");
  assert.equal(relayTargetOf("run:r1").channel, "");
  assert.equal(relayTargetOf("").channel, "");
  assert.equal(relayTargetOf("wechat").channel, "");
});

test("回话正文：空给空串，长的裁到上限且带省略号，head 也算进预算", async () => {
  const { composeRelayText } = await mod();
  assert.equal(composeRelayText(""), "");
  assert.equal(composeRelayText("   "), "");

  const long = "字".repeat(2000);
  const out = composeRelayText(long, { limit: 200 });
  assert.equal(out.length, 200);
  assert.ok(out.endsWith("…"));

  const withHead = composeRelayText(long, { limit: 200, head: "【已处理】" });
  assert.ok(withHead.startsWith("【已处理】"));
  assert.ok(withHead.length <= 200);

  // 短的不动
  assert.equal(composeRelayText("改好了", { limit: 200 }), "改好了");
});

test("relay：没有通道/没有内容/没有发送器都如实跳过，不发也不抛", async () => {
  const { relayToThread } = await mod();
  const calls = [];
  const send = async (m) => { calls.push(m); return { ok: true } };

  const noChannel = await relayToThread({ threadKey: "task:t1", text: "结果", send });
  assert.equal(noChannel.ok, false);
  assert.equal(noChannel.skipped, "no_channel");

  const empty = await relayToThread({ threadKey: "wechat:g1", text: "  ", send });
  assert.equal(empty.skipped, "empty");

  const noSender = await relayToThread({ threadKey: "wechat:g1", text: "结果" });
  assert.equal(noSender.skipped, "no_sender");

  assert.equal(calls.length, 0);
});

test("relay：命中通道就发出，成功失败都如实带回", async () => {
  const { relayToThread } = await mod();
  const seen = [];
  const ok = await relayToThread({
    threadKey: "wechat:g1", text: "已经修好了，PR 在 #12", head: "【群里那件事】",
    send: async (m) => { seen.push(m); return { ok: true, detail: "已回复" } },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.channel, "wechat");
  assert.equal(ok.to, "g1");
  assert.equal(seen[0].channel, "wechat");
  assert.ok(seen[0].body.startsWith("【群里那件事】"));

  const bad = await relayToThread({
    threadKey: "mail:m1", text: "结论：不是权限问题",
    send: async () => ({ ok: false, detail: "邮箱没登录" }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.detail, "邮箱没登录");

  const boom = await relayToThread({
    threadKey: "wechat:g2", text: "x",
    send: async () => { throw new Error("熔断中") },
  });
  assert.equal(boom.ok, false);
  assert.match(boom.detail, /熔断中/);
});
