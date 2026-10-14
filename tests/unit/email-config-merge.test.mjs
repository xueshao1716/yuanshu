// 邮箱配置保存契约：前端拿到的是脱敏配置，整包写回时不能清空已配好的密钥（2026-10-13 修复）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("saveConfig 保留未回传的密钥，新增 IMAP 账号的授权码照常保存", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-email-"));
  process.env.PI_WORKSPACE = ws;
  try {
    const mod = await import("../../engine/email-bridge.mjs?merge-test");
    const cfgFile = path.join(ws, ".yuanshu", "email", "config.json");

    // 初始：一个已配好 OAuth 凭证的 Gmail
    mod.saveConfig({ accounts: [{ email: "g@gmail.com", provider: "gmail", enabled: true, clientId: "cid", clientSecret: "SECRET-G", refreshToken: "RT-G" }] });

    // 模拟前端：GET 脱敏后整包写回（没有 clientSecret/refreshToken），并新增一个 QQ 账号
    const masked = [{ email: "g@gmail.com", provider: "gmail", enabled: true, clientId: "cid", hasRefreshToken: true }];
    mod.saveConfig({ accounts: [...masked, { email: "me@qq.com", provider: "imap", enabled: true, preset: "qq", password: "QQ-AUTH" }] });

    const saved = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    const g = saved.accounts.find(a => a.email === "g@gmail.com");
    assert.equal(g.clientSecret, "SECRET-G", "Gmail 的 clientSecret 不能被清空");
    assert.equal(g.refreshToken, "RT-G", "Gmail 的 refreshToken 不能被清空");
    const q = saved.accounts.find(a => a.email === "me@qq.com");
    assert.equal(q.password, "QQ-AUTH", "QQ 授权码要保存");

    // status 对 IMAP 看授权码，对 OAuth 看 clientId+refreshToken
    const st = mod.status();
    assert.equal(st.accounts.find(a => a.email === "me@qq.com").hasCredentials, true);
    assert.equal(st.accounts.find(a => a.email === "g@gmail.com").hasCredentials, true);
  } finally {
    delete process.env.PI_WORKSPACE;
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
