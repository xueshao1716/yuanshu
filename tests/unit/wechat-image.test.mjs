// 微信图片发送（iLink sendImage，2026-10-08 接入）单测
// 协议依据 @tencent-weixin/openclaw-weixin@2.4.9 源码：getuploadurl → AES-128-ECB 加密上 CDN → sendmessage item_list[type:2]
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createIlinkClient } from "../../engine/wechat-ilink.mjs";
import { createWechatBridge } from "../../engine/wechat-bridge.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wximg-"));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout"); await tick(); } };

// ── 协议层：sendImage 三连请求（getuploadurl → CDN → sendmessage）──
test("sendImage：getuploadurl 参数、CDN 密文可解密回原图、item_list 结构与源码一致", async () => {
  const png = tmp() + "/a.png";
  const raw = Buffer.from("89504e470d0a1a0a-fake-png-bytes-for-test");
  fs.writeFileSync(png, raw);

  const calls = [];
  const fetch3 = async (url, init = {}) => {
    calls.push({ url, body: init.body, headers: init.headers || {}, method: init.method });
    if (url.endsWith("/getuploadurl")) {
      const body = JSON.parse(init.body);
      assert.equal(body.media_type, 1); // UploadMediaType.IMAGE
      assert.equal(body.no_need_thumb, true);
      assert.equal(body.rawsize, raw.length);
      assert.equal(body.rawfilemd5, crypto.createHash("md5").update(raw).digest("hex"));
      // filesize = 密文长度 = ceil((rawsize+1)/16)*16
      assert.equal(body.filesize, Math.ceil((raw.length + 1) / 16) * 16);
      // 接口参数 aeskey 是 32 hex 字符
      assert.match(body.aeskey, /^[0-9a-f]{32}$/);
      assert.match(body.filekey, /^[0-9a-f]{32}$/);
      return new Response(JSON.stringify({ ret: 0, upload_full_url: "https://cdn.test/upload?k=1" }), { status: 200 });
    }
    if (url.startsWith("https://cdn.test/upload")) {
      assert.equal(init.headers["Content-Type"], "application/octet-stream");
      // CDN 上传体 = AES-128-ECB(plaintext, aeskey)，能从 getuploadurl 的 aeskey 解开且 md5 一致
      const cipher = Buffer.from(init.body);
      assert.equal(cipher.length, Math.ceil((raw.length + 1) / 16) * 16, "密文长度 = filesize");
      const upBody = JSON.parse(calls[0].body);
      const key = Buffer.from(upBody.aeskey, "hex");
      const d = crypto.createDecipheriv("aes-128-ecb", key, null);
      const plain = Buffer.concat([d.update(cipher), d.final()]);
      // AES-ECB 密文比明文长（PKCS7 填充），解开后去掉尾部填充
      const unpadded = plain.subarray(0, plain.length - plain[plain.length - 1]);
      assert.equal(crypto.createHash("md5").update(unpadded).digest("hex"), crypto.createHash("md5").update(raw).digest("hex"), "解开必须是原图");
      return new Response(null, { status: 200, headers: { "x-encrypted-param": "enc-param-xyz" } });
    }
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  };

  const c = createIlinkClient({ fetch: fetch3 });
  const r = await c.sendImage("tok", png, "owner@im.wechat", "ctx-1");
  assert.deepEqual(r, { ret: 0 });
  assert.equal(calls.length, 3);

  // sendmessage 的 item_list[0] 是图片项（MessageItemType.IMAGE = 2）
  const sm = calls[2];
  assert.equal(sm.url.endsWith("/ilink/bot/sendmessage"), true);
  const msg = JSON.parse(sm.body).msg;
  assert.equal(msg.message_type, 2); // BOT
  assert.equal(msg.to_user_id, "owner@im.wechat");
  const item = msg.item_list[0];
  assert.equal(item.type, 2);
  assert.equal(item.image_item.media.encrypt_query_param, "enc-param-xyz");
  assert.equal(item.image_item.media.encrypt_type, 1);
  // 大坑①：aes_key = base64(32字节hex文本)，不是 base64(原始16字节密钥)——官方线上就这编码，服务器才认
  const upBody = JSON.parse(calls[0].body);
  assert.equal(item.image_item.media.aes_key, Buffer.from(upBody.aeskey).toString("base64"));
  // 大坑②：mid_size = 密文字节数，不是原图大小
  assert.equal(item.image_item.mid_size, Math.ceil((raw.length + 1) / 16) * 16);
});

test("sendImage：getuploadurl 失败时抛错，不去发 sendmessage", async () => {
  const png = tmp() + "/b.png";
  fs.writeFileSync(png, Buffer.from("x"));
  const urls = [];
  const c = createIlinkClient({ fetch: async (url) => { urls.push(url); return new Response(JSON.stringify({ ret: 40001, errmsg: "no auth" }), { status: 200 }); } });
  await assert.rejects(c.sendImage("tok", png, "owner"), /getuploadurl|40001|no auth/);
  assert.equal(urls.length, 1, "只调了 getuploadurl");
});

test("sendImage：upload_param 回退时拼 CDN URL（没有 upload_full_url）", async () => {
  const png = tmp() + "/c.png";
  fs.writeFileSync(png, Buffer.from("hello-cdn-fallback"));
  const urls = [];
  const c = createIlinkClient({ fetch: async (url, init = {}) => {
    urls.push(url);
    if (url.endsWith("/getuploadurl")) return new Response(JSON.stringify({ ret: 0, filekey: "f", upload_param: "p%20q" }), { status: 200 });
    if (url.startsWith("http")) return new Response(null, { status: 200, headers: { "x-encrypted-param": "e2" } });
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  } });
  const r = await c.sendImage("tok", png, "owner");
  assert.deepEqual(r, { ret: 0 });
  assert.ok(urls[1].includes("encrypted_query_param=p%2520q"), "upload_param 要再编码一次");
  assert.ok(urls[1].includes("filekey=f"));
});

// ── 桥接层：flush 图片任务 / notifyOwner 带图 / 失败不断队列 ──
function imgWorld() {
  const sent = [];
  const images = [];
  const client = {
    sendText: async (_t, to, text, ctx) => { sent.push({ to, text, ctx }); return { ret: 0 }; },
    sendImage: async (_t, image, to, ctx) => { fs.readFileSync(image); images.push({ to, image, ctx }); return { ret: 0 }; },
  };
  const chat = { n: 0, createSession: async () => `s${++chat.n}`, ask: async (text, sid) => `回：${text}` };
  return { client, chat, sent, images };
}

const pngPath = (dir, name = "t.png") => { const p = path.join(dir, name); fs.writeFileSync(p, Buffer.from("89504e470d0a")); return p; };

test("notifyOwner(text, imagePath)：文字走 sendText，图片随后走 sendImage", async () => {
  const dir = tmp(), w = imgWorld();
  const png = pngPath(dir);
  fs.writeFileSync(path.join(dir, "account.json"), JSON.stringify({ token: "T", botId: "bot@im.bot", userId: "owner@im.wechat" }));
  const b = createWechatBridge({ dir, client: w.client, chat: w.chat, sleep: () => tick() });
  b.start();
  b.setNotify(true);
  await b.notifyOwner("图画好了", png);
  await until(() => w.images.length === 1 && b.status().stats.replied === 2);
  assert.deepEqual(w.images[0], { to: "owner@im.wechat", image: png, ctx: "" });
  assert.deepEqual(w.sent[0], { to: "owner@im.wechat", text: "图画好了", ctx: "" });
  assert.equal(b.status().stats.failed, 0);
  assert.ok(!b.status().stats.lastError, "不应有错误");
  await b.stop(); await b._waitIdle();
});

test("图片发送失败（文件不存在）：记 failed 不抛错，后续队列照旧发", async () => {
  const dir = tmp(), w = imgWorld();
  fs.writeFileSync(path.join(dir, "account.json"), JSON.stringify({ token: "T", botId: "bot@im.bot", userId: "owner@im.wechat" }));
  const b = createWechatBridge({ dir, client: w.client, chat: w.chat, sleep: () => tick() });
  b.start();
  b.setNotify(true);
  const missing = path.join(dir, "no-such.png");
  await b.notifyOwner("先发我", missing); // 不 reject
  w.client.sendText = async (_t, to, text, ctx) => { w.sent.push({ to, text, ctx }); return { ret: 0 }; };
  await b.notifyOwner("再来一句");
  await until(() => w.sent.length === 2);
  const st = b.status().stats;
  assert.equal(st.failed, 1, "图片失败记一次");
  assert.match(st.lastError, /no-such|ENOENT|发送异常/);
  assert.equal(w.sent[1].text, "再来一句");
  await b.stop(); await b._waitIdle();
});

test("sendImage 返回 ret≠0：记 failed 与 lastError", async () => {
  const dir = tmp(), w = imgWorld();
  w.client.sendImage = async () => ({ ret: 20001, errmsg: "图片太大" });
  const png = pngPath(dir);
  fs.writeFileSync(path.join(dir, "account.json"), JSON.stringify({ token: "T", botId: "bot@im.bot", userId: "owner@im.wechat" }));
  const b = createWechatBridge({ dir, client: w.client, chat: w.chat, sleep: () => tick() });
  b.start();
  b.setNotify(true);
  await b.notifyOwner("", png);
  await until(() => b.status().stats.lastError);
  assert.equal(b.status().stats.failed, 1);
  assert.match(b.status().stats.lastError, /20001|图片太大/);
  await b.stop(); await b._waitIdle();
});
