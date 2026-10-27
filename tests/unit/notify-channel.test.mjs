// 推送通道界面化：保存 / 测试 / 清除 / 打开控制台（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readToken, saveToken, clearToken, validateToken, channelStatus, sendTest, maskToken, TOKEN_REL,
} from "../../engine/notify-channel.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "notify-"));

test("token 校验：空/太短/非法字符都挡住，正常放行", () => {
  assert.equal(validateToken("").ok, false);
  assert.equal(validateToken("short").ok, false);
  assert.equal(validateToken("abc def ghi jkl mno").ok, false, "空格不合法");
  assert.equal(validateToken("0123456789abcdef0123456789abcdef").ok, true);
});

test("保存/读取/清除：落到工作区那一行文件里，状态只回脱敏尾巴", () => {
  const root = ws();
  assert.equal(readToken(root), "");
  assert.equal(channelStatus(root).configured, false);

  const token = "0123456789abcdef0123456789abcdef";
  const saved = saveToken(root, ` ${token} `);
  assert.equal(saved.ok, true);
  assert.equal(readToken(root), token, "要去掉首尾空白");
  assert.ok(fs.existsSync(path.join(root, TOKEN_REL)));

  const st = channelStatus(root);
  assert.equal(st.configured, true);
  assert.equal(st.masked, maskToken(token));
  assert.ok(!JSON.stringify(st).includes(token), "状态里不能出现 token 明文");

  clearToken(root);
  assert.equal(channelStatus(root).configured, false);
});

test("测试推送：成功/失败都写状态，且失败给错误", async () => {
  const root = ws();
  saveToken(root, "0123456789abcdef0123456789abcdef");

  const okFetch = async () => ({ status: 200, text: async () => JSON.stringify({ code: 200, msg: "ok" }) });
  const ok = await sendTest(root, { fetch: okFetch });
  assert.equal(ok.ok, true);
  let st = channelStatus(root);
  assert.equal(st.ok, true);
  assert.equal(st.okCount, 1);

  const badFetch = async () => ({ status: 500, text: async () => "server error" });
  const bad = await sendTest(root, { fetch: badFetch });
  assert.equal(bad.ok, false);
  st = channelStatus(root);
  assert.equal(st.ok, false);
  assert.equal(st.failCount, 1);
  assert.match(st.detail, /500/);
});

test("没保存 token 时测试直接拒绝（不发请求）", async () => {
  const root = ws();
  let called = false;
  const r = await sendTest(root, { fetch: async () => { called = true; return { status: 200, text: async () => "{}" } } });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});
