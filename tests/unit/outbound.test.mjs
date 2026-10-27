// 向外发接口层：降级链 + 投递账本（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendOut, readLedger, recentDeliveries, outboundLine, payloadOf, isEmptyPayload, kindOf, LEDGER_REL } from "../../engine/outbound.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "outbound-"));

const okWechat = () => ({ notifyOwner: async () => ({ failedText: 0 }) });
const badWechat = () => ({ notifyOwner: async () => ({ failedText: 1, error: "ret=-2 prepare failed" }) });

test("首选通道成功：落账 + 不降级", async () => {
  const root = ws();
  const r = await sendOut({ wsRoot: root, text: "hi", deps: { wechat: okWechat() } });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "wechat");
  assert.equal(r.fallbacks, 0);
  const ledger = readLedger(root);
  assert.equal(ledger.items[0].ok, true);
  assert.equal(ledger.items[0].channel, "wechat");
  assert.ok(fs.existsSync(path.join(root, LEDGER_REL)));
});

test("首选失败 → 自动降级到下一个通道，并记失败账", async () => {
  const root = ws();
  const r = await sendOut({
    wsRoot: root, text: "hi", channel: "wechat", fallback: ["wechat", "webhook"],
    deps: { wechat: badWechat(), webhook: async () => ({ ok: true }) },
  });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "webhook");
  assert.equal(r.fallbacks, 1);
  const items = recentDeliveries(root, { limit: 5 });
  assert.ok(items.some((i) => i.channel === "wechat" && !i.ok), "失败也要留痕");
  assert.ok(items.some((i) => i.channel === "webhook" && i.ok));
});

test("全通道失败：返回 tried 链，账本全是失败", async () => {
  const root = ws();
  const r = await sendOut({ wsRoot: root, text: "hi", fallback: ["wechat", "email"], deps: { wechat: badWechat() } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.tried, ["wechat", "email"]);
  assert.ok(recentDeliveries(root, { limit: 10 }).every((i) => !i.ok));
  assert.match(outboundLine(root), /【投递】/);
});

test("空内容直接拒绝，不碰台账", async () => {
  const root = ws();
  const r = await sendOut({ wsRoot: root, text: "", deps: { wechat: okWechat() } });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "none");
  assert.equal(readLedger(root).items.length, 0);
});

test("内容类型判定：语音 > 文件 > 图片 > 文本", () => {
  assert.equal(kindOf(payloadOf({ text: "a", image: "b", file: "c", voice: "d" })), "voice");
  assert.equal(kindOf(payloadOf({ text: "a", file: "c" })), "file");
  assert.equal(kindOf(payloadOf({ text: "a", image: "b" })), "image");
  assert.equal(kindOf(payloadOf({ text: "a" })), "text");
  assert.equal(isEmptyPayload(payloadOf({})), true);
});

test("微信语音走 sendVoice；没有 sendVoice 时降级", async () => {
  const root = ws();
  const withVoice = { notifyOwner: async () => ({ failedText: 0 }), sendVoice: async () => ({ playtimeMs: 1200 }) };
  const r = await sendOut({ wsRoot: root, voice: "你好", deps: { wechat: withVoice } });
  assert.equal(r.ok, true);
  assert.match(r.detail, /语音/);

  const noVoice = { notifyOwner: async () => ({ failedText: 0 }) };
  const r2 = await sendOut({ wsRoot: root, voice: "你好", channel: "wechat", fallback: ["wechat", "webhook"], deps: { wechat: noVoice, webhook: async () => ({ ok: true }) } });
  assert.equal(r2.channel, "webhook");
});
