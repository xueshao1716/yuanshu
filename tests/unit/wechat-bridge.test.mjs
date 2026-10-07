import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeMessage, splitForWechat, stripMarkdownForWechat, updatesOk, createIlinkClient } from "../../engine/wechat-ilink.mjs";
import { createWechatBridge, createLoopbackChat, maskId, readChatStream, readRunStream } from "../../engine/wechat-bridge.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wx-"));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout"); await tick(); } };

test("normalizeMessage：私聊文本、群消息、自己发的", () => {
  const dm = normalizeMessage({ from_user_id: "u1@im.wechat", context_token: "c", item_list: [{ type: 1, text_item: { text: " 你好 " } }, { type: 2 }] }, "bot@im.bot");
  assert.deepEqual([dm.sender, dm.text, dm.isGroup, dm.itemTypes, dm.contextToken], ["u1@im.wechat", "你好", false, "1,2", "c"]);
  assert.equal(normalizeMessage({ from_user_id: "g@chatroom", item_list: [] }).isGroup, true);
  assert.equal(normalizeMessage({ from_user_id: "bot@im.bot" }, "bot@im.bot"), null);
  assert.equal(normalizeMessage({}), null);
});

test("splitForWechat：超长按段落切，每段不超过上限", () => {
  const para = "一二三四五六七八九十。".repeat(30);
  const parts = splitForWechat(`${para}\n\n${para}\n\n${para}`, 400);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((p) => p.length <= 400 && p.length > 0));
  assert.equal(parts.join("").replace(/\s/g, ""), `${para}${para}${para}`);
  assert.deepEqual(splitForWechat("短句"), ["短句"]);
  assert.deepEqual(splitForWechat(""), []);
});

test("updatesOk 以 msgs 数组为准", () => {
  assert.equal(updatesOk({ msgs: [] }), true);
  assert.equal(updatesOk({ ret: 0 }), true);
  assert.equal(updatesOk({ ret: -14 }), false);
});

test("ilink 客户端带上协议头和 base_info", async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ret: 0 })); };
  const c = createIlinkClient({ fetch: fake, base: "https://x" });
  await c.sendText("tok", "u1", "hi", "ctx");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://x/ilink/bot/sendmessage");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.equal(calls[0].init.headers["iLink-App-Id"], "bot");
  assert.equal(body.base_info.channel_version, "2.2.0");
  assert.equal(body.msg.context_token, "ctx");
  assert.equal(body.msg.item_list[0].text_item.text, "hi");
});

test("maskId 不暴露完整微信号", () => {
  assert.equal(maskId("o9cq80wXRB4rZOPZ4BMbRWqK-pas@im.wechat"), "o9cq…pas@im.wechat");
  assert.equal(maskId(""), "");
});

test("readChatStream 只收正文，error 事件抛出", async () => {
  const sse = (s) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } }));
  assert.equal(await readChatStream(sse('event: tool\ndata: {"name":"bash"}\n\nevent: delta\ndata: {"text":"你"}\n\nevent: delta\ndata: {"text":"好"}\n\n')), "你好");
  await assert.rejects(readChatStream(sse('event: error\ndata: {"message":"坏了"}\n\n')), /坏了/);
});

function fakeWorld() {
  const sent = [];
  let inbox = [];
  const client = {
    fetchQr: async () => ({ value: "q1", url: "https://liteapp/q1" }),
    qrStatus: async () => ({ status: "confirmed", bot_token: "T", ilink_bot_id: "bot@im.bot", ilink_user_id: "owner@im.wechat" }),
    getUpdates: async (_t, cursor) => { await tick(2); const msgs = inbox; inbox = []; return { msgs, get_updates_buf: `b${(+String(cursor.buf).slice(1) || 0) + 1}` }; },
    sendText: async (_t, to, text, ctx) => { sent.push({ to, text, ctx }); return { ret: 0 }; },
  };
  const asked = [];
  const chat = {
    n: 0,
    createSession: async () => `s${++chat.n}`,
    ask: async (text, sid, opts = {}) => { asked.push([text, sid, !!opts.owner]); return `回：${text}`; },
  };
  return { client, chat, sent, asked, push: (m) => inbox.push(m) };
}
const dm = (from, text, ctx = "c") => ({ from_user_id: from, context_token: ctx, item_list: [{ type: 1, text_item: { text } }] });

test("扫码登录 → 自动开始收发；status 不含凭证", async () => {
  const dir = tmp(), w = fakeWorld();
  const b = createWechatBridge({ dir, client: w.client, chat: w.chat, sleep: () => tick() });
  b.startLogin();
  await until(() => b.status().running);
  w.push(dm("u1@im.wechat", "在吗"));
  w.push(dm("g@chatroom", "群里"));
  await until(() => w.sent.length === 1);
  assert.deepEqual(w.sent[0], { to: "u1@im.wechat", text: "回：在吗", ctx: "c" });
  const st = b.status();
  assert.equal(st.loggedIn, true);
  assert.equal(st.enabled, true);
  assert.equal(st.login.state, "confirmed");
  assert.equal(st.friends, 1);
  assert.ok(!JSON.stringify(st).includes('"T"'));
  assert.ok(!JSON.stringify(st).includes("u1@im.wechat"));
  assert.ok(fs.readFileSync(path.join(dir, "cursor.json"), "utf-8").includes("b"));
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8"), "*\n");
  await b.stop();
  await b._waitIdle();
  assert.equal(b.status().enabled, false);
});

test("同一好友复用会话；会话失效换新会话重试一次", async () => {
  const dir = tmp(), w = fakeWorld();
  let fail = true;
  const ask = w.chat.ask;
  w.chat.ask = async (t, sid) => { if (sid === "s1" && fail && t === "第二句") { fail = false; throw Object.assign(new Error("404"), { status: 404 }); } return ask(t, sid); };
  fs.writeFileSync(path.join(dir, "account.json"), JSON.stringify({ token: "T", botId: "bot@im.bot", userId: "owner@im.wechat" }));
  const b = createWechatBridge({ dir, client: w.client, chat: w.chat, sleep: () => tick() });
  b.start();
  w.push(dm("u1@im.wechat", "第一句"));
  await until(() => w.sent.length === 1);
  w.push(dm("u1@im.wechat", "第二句"));
  await until(() => w.sent.length === 2);
  assert.deepEqual(w.asked.map((a) => a[1]), ["s1", "s2"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "sessions.json"), "utf-8"))["u1@im.wechat"], "s2");
  await b.stop(); await b._waitIdle();
});

test("首次启动接管独立桥凭证（默认不自动开），notifyOwner 带上最近的 context", async () => {
  const dir = tmp(), legacy = tmp(), w = fakeWorld();
  fs.writeFileSync(path.join(legacy, "ilink-weixin-account.json"), JSON.stringify({ token: "T", botId: "bot@im.bot", userId: "owner@im.wechat" }));
  fs.writeFileSync(path.join(legacy, "ilink-bridge-state.json"), JSON.stringify({ buf: "b7", ack: "" }));
  fs.writeFileSync(path.join(legacy, "ilink-weixin-sessions.json"), JSON.stringify({ "owner@im.wechat": "old-session" }));
  const b = createWechatBridge({ dir, client: w.client, chat: w.chat, legacyDir: legacy, sleep: () => tick() });
  b.boot();
  assert.equal(b.status().loggedIn, true);
  assert.equal(b.status().running, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "cursor.json"), "utf-8")).buf, "b7");
  b.start();
  w.push(dm("owner@im.wechat", "嗨", "ctx-owner"));
  await until(() => w.sent.length === 1);
  assert.equal(w.asked[0][1], "old-session");
  await assert.rejects(b.notifyOwner("x"), /通知发到微信/);
  b.setNotify(true);
  await b.notifyOwner("构建好了");
  assert.deepEqual(w.sent[1], { to: "owner@im.wechat", text: "构建好了", ctx: "ctx-owner" });
  await b.logout(); await b._waitIdle();
  assert.equal(b.status().loggedIn, false);
  // 已接管过就不再从旧目录覆盖回来之外，旧文件保持原样
  assert.ok(fs.existsSync(path.join(legacy, "ilink-weixin-account.json")));
});

test("没登录不能开启", () => {
  const b = createWechatBridge({ dir: tmp(), client: fakeWorld().client, chat: fakeWorld().chat });
  assert.throws(() => b.start(), /扫码/);
});

test("退出登录后重启不会从独立桥复活", () => {
  const dir = tmp(), legacy = tmp(), w = fakeWorld();
  fs.writeFileSync(path.join(legacy, "ilink-weixin-account.json"), JSON.stringify({ token: "T", botId: "b" }));
  createWechatBridge({ dir, client: w.client, chat: w.chat, legacyDir: legacy }).boot();
  fs.rmSync(path.join(dir, "account.json"));
  const again = createWechatBridge({ dir, client: w.client, chat: w.chat, legacyDir: legacy });
  again.boot();
  assert.equal(again.status().loggedIn, false);
});

test("微信回复翻译成版式（标题/表格/强调/引用），且幂等", () => {
  const md = "## 结论\n\n| 项 | 状态 |\n|---|---|\n| 构建 | **通过** |\n\n- 看 `log`\n> 引用\n[链接](https://x.y)";
  const out = stripMarkdownForWechat(md);
  assert.equal(
    out,
    "▎结论\n\n▪ 项：构建\n　状态：「通过」\n\n• 看「log」\n┃ 引用\n链接（https://x.y）"
  );
  assert.equal(stripMarkdownForWechat(out), out);
  // 表格单元格里带转义竖线 \|：不残留反斜杠、不错切列
  const out2 = stripMarkdownForWechat("| 符号 | 示例 |\n|---|---|\n| 表格线 \\| | x |");
  assert.equal(out2, "▪ 符号：表格线 |\n　示例：x");
});

test("只有扫码绑定的本人走任务链路（才有母体执行身份），陌生人不走", async () => {
  const dir = tmp(), w = fakeWorld();
  fs.writeFileSync(path.join(dir, "account.json"), JSON.stringify({ token: "T", botId: "bot@im.bot", userId: "owner@im.wechat" }));
  const b = createWechatBridge({ dir, client: w.client, chat: w.chat, sleep: () => tick() });
  b.start();
  w.push(dm("owner@im.wechat", "我本人"));
  await until(() => w.sent.length === 1);
  w.push(dm("u9@im.wechat", "陌生人"));
  await until(() => w.sent.length === 2);
  assert.deepEqual(w.asked.map((a) => [a[0], a[2]]), [["我本人", true], ["陌生人", false]]);
  await b.stop(); await b._waitIdle();
});

const sse = (events) => new Response(events.map((e, i) => `id: ${i + 1}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));

test("readRunStream 只收 delta 正文；失败且无正文时抛错，404 类带 status", async () => {
  assert.equal(await readRunStream(sse([{ type: "tool", data: { name: "cultivation" } }, { type: "delta", data: { text: "你" } }, { type: "delta", data: { text: "好" } }, { type: "completed", data: {} }])), "你好");
  await assert.rejects(readRunStream(sse([{ type: "failed", data: { message: "session not found" } }])), (e) => e.status === 404);
  assert.equal(await readRunStream(sse([{ type: "delta", data: { text: "半句" } }, { type: "interrupted", data: {} }])), "半句");
});

test("回环聊天：本人走 /api/runs（不续跑），其他人仍走 /api/chat", async () => {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push([url.replace("http://h", ""), init.body ? JSON.parse(init.body) : null]);
    if (url.endsWith("/api/runs")) return new Response(JSON.stringify({ runId: "r1" }), { status: 202 });
    if (url.includes("/api/runs/r1/events")) return sse([{ type: "delta", data: { text: "好" } }, { type: "completed", data: {} }]);
    return new Response('event: delta\ndata: {"text":"旧"}\n\n');
  };
  const chat = createLoopbackChat({ base: () => "http://h", token: () => "k", fetch: f, now: () => 7 });
  assert.equal(await chat.ask("hi", "s1", { owner: true }), "好");
  assert.equal(await chat.ask("hi", "s2"), "旧");
  assert.deepEqual(calls.map((c) => c[0]), ["/api/runs", "/api/runs/r1/events?after=0", "/api/chat"]);
  assert.equal(calls[0][1].backgroundRecovery, false);
  assert.equal(calls[0][1].clientRequestId, "wechat-s1-7");
});

test("readRunStream 收到终态就断开，不等服务端关流（真机：桥会一直挂着）", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(enc.encode('event: delta\ndata: {"type":"delta","data":{"text":"通了"}}\n\n'));
      c.enqueue(enc.encode('event: completed\ndata: {"type":"completed","data":{}}\n\n'));
      // 故意不 close：服务端事件流在任务结束后保持心跳
    },
    cancel() { cancelled = true; },
  });
  const r = await Promise.race([readRunStream(new Response(body)), new Promise((_, no) => setTimeout(() => no(new Error("挂住了")), 1000))]);
  assert.equal(r, "通了");
  assert.equal(cancelled, true);
});

// 2026-10-07 真机：伙伴的「那你给注册了吧」「怎么不回话了」都在服务重启时被掐断，桥和服务同进程，回复永远丢了。
test("处理中被重启打断的消息：下次启动告诉对方重发，不自动重跑", async () => {
  const dir = tmp(), w = fakeWorld();
  fs.writeFileSync(path.join(dir, "account.json"), JSON.stringify({ token: "T", botId: "bot@im.bot", userId: "owner@im.wechat" }));
  fs.writeFileSync(path.join(dir, "inbox.json"), JSON.stringify({ "owner@im.wechat": { text: "那你给注册了吧", contextToken: "c0", at: Date.UTC(2026, 9, 6, 18, 19) } }));
  const b = createWechatBridge({ dir, client: w.client, chat: w.chat, sleep: () => tick() });
  b.start();
  await until(() => w.sent.length === 1);
  assert.match(w.sent[0].text, /重启/); assert.match(w.sent[0].text, /那你给注册了吧/); assert.match(w.sent[0].text, /再发/);
  assert.equal(w.sent[0].ctx, "c0");
  assert.equal(w.asked.length, 0, "不自动重跑");
  await until(() => fs.readFileSync(path.join(dir, "inbox.json"), "utf-8").trim() === "{}");
  await b.stop(); await b._waitIdle();
});

test("处理中落盘，回完清掉；处理中再来的消息排队接着回，不再丢", async () => {
  const dir = tmp(), w = fakeWorld();
  let release;
  const gate = new Promise((r) => { release = r; });
  const ask = w.chat.ask;
  let started = false;
  w.chat.ask = async (t, sid, o) => { if (t === "长任务") { assert.ok(fs.readFileSync(path.join(dir, "inbox.json"), "utf-8").includes("长任务")); started = true; await gate; } return ask(t, sid, o); };
  fs.writeFileSync(path.join(dir, "account.json"), JSON.stringify({ token: "T", botId: "bot@im.bot", userId: "owner@im.wechat" }));
  const b = createWechatBridge({ dir, client: w.client, chat: w.chat, sleep: () => tick(), ackAfterMs: 0 });
  b.start();
  w.push(dm("u1@im.wechat", "长任务"));
  await until(() => started);
  w.push(dm("u1@im.wechat", "第二句"));
  w.push(dm("u1@im.wechat", "第三句"));
  await until(() => w.sent.length === 1);
  assert.match(w.sent[0].text, /记下了/);
  release();
  await until(() => w.sent.length === 3);
  assert.equal(w.sent[1].text, "回：长任务");
  assert.equal(w.sent[2].text, "回：第二句\n第三句");
  await until(() => fs.readFileSync(path.join(dir, "inbox.json"), "utf-8").trim() === "{}");
  await b.stop(); await b._waitIdle();
});

test("长任务超过时限先回一句在处理，答完再回正文", async () => {
  const dir = tmp(), w = fakeWorld();
  let release;
  const gate = new Promise((r) => { release = r; });
  const ask = w.chat.ask;
  w.chat.ask = async (t, sid, o) => { await gate; return ask(t, sid, o); };
  fs.writeFileSync(path.join(dir, "account.json"), JSON.stringify({ token: "T", botId: "bot@im.bot", userId: "owner@im.wechat" }));
  const b = createWechatBridge({ dir, client: w.client, chat: w.chat, sleep: () => tick(), ackAfterMs: 20 });
  b.start();
  w.push(dm("u1@im.wechat", "查一下"));
  await until(() => w.sent.length === 1);
  assert.match(w.sent[0].text, /做完回你/);
  release();
  await until(() => w.sent.length === 2);
  assert.equal(w.sent[1].text, "回：查一下");
  await tick(40);
  assert.equal(w.sent.length, 2, "只提醒一次");
  await b.stop(); await b._waitIdle();
});
