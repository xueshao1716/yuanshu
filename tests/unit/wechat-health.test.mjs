// 微信桥健康度 + 推送通道状态（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { healthOf } from "../../engine/wechat-bridge.mjs";
import { createWechatBridge } from "../../engine/wechat-bridge.mjs";

const NOW = 1_800_000_000_000;

test("健康度：正常 / 空闲 / 降级 / 过期 / 停止", () => {
  assert.equal(healthOf({ running: true, login: {}, stats: { lastOkAt: NOW - 1000 }, now: NOW }).state, "ok");
  assert.equal(healthOf({ running: true, login: {}, stats: {}, now: NOW }).state, "idle");
  assert.equal(healthOf({ running: false, login: {}, stats: {}, now: NOW }).state, "off");
  assert.equal(healthOf({ running: true, login: { state: "expired" }, stats: { lastOkAt: NOW - 1000 }, now: NOW }).state, "expired",
    "过期优先级最高：即使刚成功过也要报过期");
  const degraded = healthOf({ running: true, login: {}, stats: { lastError: "ret=-1 登录失效", consecutiveFailures: 4, lastOkAt: NOW - 600000 }, now: NOW });
  assert.equal(degraded.state, "degraded");
  assert.match(degraded.text, /连续失败 4 次/);
});

test("健康度：长时间没收到回复 → stale，且文案带分钟数", () => {
  const r = healthOf({ running: true, login: {}, stats: { lastOkAt: NOW - 12 * 60000 }, now: NOW });
  assert.equal(r.state, "stale");
  assert.match(r.text, /12 分钟/);
});

test("桥 status() 带 health 字段（不再只有 running:true）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-"));
  fs.writeFileSync(path.join(dir, "account.json"), JSON.stringify({ token: "t", botId: "b", userId: "u" }), "utf8");
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabled: false, notify: false }), "utf8");

  const bridge = createWechatBridge({
    dir, chat: { send: async () => ({ ok: true }) }, log: () => {}, sleep: async () => {},
    client: { getUpdates: async () => ({ msgs: [] }) }, now: () => NOW,
  });
  const st = bridge.status();
  assert.ok(st.health, "status 必须带 health");
  assert.equal(st.health.state, "off", "没启动时是 off");
  assert.equal(typeof st.health.text, "string");
  assert.ok(!("token" in st), "status 不能泄露 token");
});
