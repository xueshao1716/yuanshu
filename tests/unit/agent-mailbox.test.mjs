// agent 留言：广播/定向/未读/已读（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { postMessage, inboxFor, markRead, unreadCount, mailboxLine, recentMessages } from "../../engine/agent-mailbox.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-"));

test("定向消息只有收件人看得到；广播所有人都看得到", () => {
  const root = ws();
  postMessage({ wsRoot: root, from: "甲", to: "乙", text: "只给乙" });
  postMessage({ wsRoot: root, from: "甲", text: "给大家" });

  const toB = inboxFor(root, "乙").map((m) => m.text);
  assert.deepEqual(toB.sort(), ["只给乙", "给大家"].sort());

  const toC = inboxFor(root, "丙").map((m) => m.text);
  assert.deepEqual(toC, ["给大家"]);
});

test("自己发的不出现在自己的收件箱", () => {
  const root = ws();
  postMessage({ wsRoot: root, from: "小语", text: "我自己说的" });
  assert.equal(inboxFor(root, "小语").length, 0);
});

test("未读计数 + 标记已读后消失", () => {
  const root = ws();
  postMessage({ wsRoot: root, from: "甲", text: "一" });
  postMessage({ wsRoot: root, from: "甲", text: "二" });
  assert.equal(unreadCount(root, "小语"), 2);
  assert.match(mailboxLine(root, "小语"), /2 条未读/);

  const ids = inboxFor(root, "小语").map((m) => m.id);
  markRead({ wsRoot: root, agent: "小语", ids });
  assert.equal(unreadCount(root, "小语"), 0);
  assert.equal(mailboxLine(root, "小语"), "");
});

test("空文本被拒；未知 kind 降级成 note", () => {
  const root = ws();
  assert.equal(postMessage({ wsRoot: root, text: "  " }).ok, false);
  const r = postMessage({ wsRoot: root, from: "甲", text: "x", kind: "乱写" });
  assert.equal(r.message.kind, "note");
});

test("recentMessages 按时间倒序给面板", () => {
  const root = ws();
  postMessage({ wsRoot: root, from: "甲", text: "早", at: 1000 });
  postMessage({ wsRoot: root, from: "乙", text: "晚", at: 2000 });
  const rows = recentMessages(root, { limit: 5 });
  assert.equal(rows[0].text, "晚");
  assert.equal(rows[1].text, "早");
});

test("问与答可以用 replyTo 串起来", () => {
  const root = ws();
  const q = postMessage({ wsRoot: root, from: "甲", to: "乙", text: "这个接口谁在改？", kind: "question" });
  const a = postMessage({ wsRoot: root, from: "乙", to: "甲", text: "我在改，别动", kind: "answer", replyTo: q.message.id });
  assert.equal(a.message.replyTo, q.message.id);
  assert.equal(inboxFor(root, "甲")[0].kind, "answer");
});
