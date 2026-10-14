// 通用 IMAP（授权码）契约：登录、163 的 ID 命令、授权码错误、中文头解码、不改已读状态（2026-10-13）
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { imapSessionUnread, decodeMime, imapQuote, IMAP_PRESETS } from "../../engine/email-bridge.mjs";

const PASS = "AUTH123";

// 模拟 IMAP 服务端：按命令返回脚本化应答，应答异步送回（和真实 TLS socket 一样）
class FakeImap extends EventEmitter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.sent = [];
    setImmediate(() => this.emit("data", Buffer.from("* OK fake imap ready\r\n")));
  }
  write(s) {
    this.sent.push(s);
    const m = s.match(/^(\S+) ([\s\S]*)\r\n$/);
    const reply = this.handler(m[1], m[2]);
    setImmediate(() => this.emit("data", Buffer.from(reply)));
    return true;
  }
  destroy() {}
}

const b64 = s => Buffer.from(s, "utf8").toString("base64");
const SUBJECT = "欢迎使用邮箱";
const FROM_NAME = "张三";

function headerBlock() {
  return `From: =?UTF-8?B?${b64(FROM_NAME)}?= <zhang@example.com>\r\n` +
    `Subject: =?UTF-8?B?${b64(SUBJECT)}?=\r\n` +
    `Date: Tue, 13 Oct 2026 10:00:00 +0800\r\n\r\n`;
}

function serverHandler(password = PASS) {
  return (tag, cmd) => {
    if (cmd.startsWith("ID ")) return `${tag} OK ID completed\r\n`;
    if (cmd.startsWith("LOGIN ")) {
      return cmd.includes(imapQuote(password))
        ? `${tag} OK LOGIN completed\r\n`
        : `${tag} NO LOGIN failed: invalid credentials\r\n`;
    }
    if (cmd === "SELECT INBOX") return `${tag} OK SELECT completed\r\n`;
    if (cmd === "UID SEARCH UNSEEN") return `* SEARCH 101 102\r\n${tag} OK SEARCH completed\r\n`;
    if (cmd.startsWith("UID FETCH ")) {
      const h = headerBlock();
      return `* 1 FETCH (UID 101 BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(h)}}\r\n${h})\r\n${tag} OK FETCH completed\r\n`;
    }
    if (cmd === "LOGOUT") return `* BYE logout\r\n${tag} OK LOGOUT completed\r\n`;
    return `${tag} BAD unknown command\r\n`;
  };
}

test("QQ 类（无需 ID）：授权码登录成功，解出中文主题与发件人，返回未读", async () => {
  const sock = new FakeImap(serverHandler());
  const emails = await imapSessionUnread(sock, { email: "me@qq.com", password: PASS, idRequired: false });
  assert.equal(emails.length, 2, "SEARCH 返回 2 封未读");
  assert.equal(emails[0].subject, SUBJECT);
  assert.ok(emails[0].from.includes(FROM_NAME), `发件人应解码: ${emails[0].from}`);
  assert.equal(emails[0].provider, "imap");
  assert.equal(emails[0].account, "me@qq.com");
  assert.ok(!sock.sent.some(c => c.includes("ID (")), "QQ 不发 ID 命令");
});

test("163/126：登录前必须先发 IMAP ID 命令", async () => {
  const sock = new FakeImap(serverHandler());
  await imapSessionUnread(sock, { email: "me@163.com", password: PASS, idRequired: true });
  const idIdx = sock.sent.findIndex(c => c.includes("ID ("));
  const loginIdx = sock.sent.findIndex(c => c.includes("LOGIN "));
  assert.ok(idIdx >= 0, "发了 ID");
  assert.ok(idIdx < loginIdx, "ID 在 LOGIN 之前");
});

test("授权码错误：报错提示用授权码，且错误信息不含密码", async () => {
  const sock = new FakeImap(serverHandler(PASS));
  await assert.rejects(
    () => imapSessionUnread(sock, { email: "me@qq.com", password: "WRONG-PWD-999", idRequired: false }),
    e => {
      assert.match(e.message, /授权码/);
      assert.ok(!e.message.includes("WRONG-PWD-999"), "错误信息不能回显密码");
      return true;
    },
  );
});

test("取头使用 BODY.PEEK：不把邮件标记为已读（不发 BODY[TEXT] / 不 STORE \\Seen）", async () => {
  const sock = new FakeImap(serverHandler());
  await imapSessionUnread(sock, { email: "me@qq.com", password: PASS, idRequired: false });
  const fetches = sock.sent.filter(c => c.includes("UID FETCH"));
  assert.ok(fetches.length > 0);
  for (const f of fetches) {
    assert.ok(f.includes("BODY.PEEK["), "用 PEEK");
    assert.ok(!/BODY\[(?!HEADER)/.test(f), "不取非 PEEK 的正文");
  }
  assert.ok(!sock.sent.some(c => /STORE/i.test(c)), "不改标志");
});

test("RFC 2047 解码：B 编码 UTF-8、Q 编码、解不出原样返回", () => {
  assert.equal(decodeMime(`=?UTF-8?B?${b64("中文标题")}?=`), "中文标题");
  assert.equal(decodeMime("=?UTF-8?Q?Hello_=E4=B8=AD?="), "Hello 中");
  assert.equal(decodeMime("plain subject"), "plain subject");
});

test("预设：QQ/163/126 指向正确服务器，163/126 标记需要 ID", () => {
  assert.equal(IMAP_PRESETS.qq.host, "imap.qq.com");
  assert.equal(IMAP_PRESETS["163"].host, "imap.163.com");
  assert.equal(IMAP_PRESETS["126"].host, "imap.126.com");
  assert.equal(IMAP_PRESETS["163"].idRequired, true);
  assert.equal(IMAP_PRESETS.qq.idRequired, false);
});
