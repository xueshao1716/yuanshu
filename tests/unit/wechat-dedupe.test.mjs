// 微信去重：id 去重 / 内容指纹去重 / 5 分钟窗口（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAndMark, readSeen, WINDOW_MS } from "../../engine/wechat-dedupe.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "wxdedupe-"));

test("同 message_id 第二次算重复", () => {
  const root = ws();
  const t = Date.now();
  assert.equal(checkAndMark({ wsRoot: root, sender: "u1", text: "你好", messageId: "m1", now: t }).dupe, false);
  const second = checkAndMark({ wsRoot: root, sender: "u1", text: "你好", messageId: "m1", now: t + 1000 });
  assert.equal(second.dupe, true);
  assert.equal(second.reason, "message_id");
});

test("换了 message_id 但内容相同 → 内容指纹也算重复（这是我们以前完全没防的）", () => {
  const root = ws();
  const t = Date.now();
  checkAndMark({ wsRoot: root, sender: "u1", text: "帮我看下磁盘", messageId: "m1", now: t });
  const again = checkAndMark({ wsRoot: root, sender: "u1", text: "帮我看下磁盘", messageId: "m999", now: t + 2000 });
  assert.equal(again.dupe, true);
  assert.equal(again.reason, "content");
});

test("不同人发同样的话不算重复", () => {
  const root = ws();
  const t = Date.now();
  checkAndMark({ wsRoot: root, sender: "u1", text: "在吗", now: t });
  assert.equal(checkAndMark({ wsRoot: root, sender: "u2", text: "在吗", now: t + 100 }).dupe, false);
});

test("同一个人隔久了重发同样的话 → 不算重复（5 分钟窗口）", () => {
  const root = ws();
  const t = Date.now();
  checkAndMark({ wsRoot: root, sender: "u1", text: "早", now: t });
  assert.equal(checkAndMark({ wsRoot: root, sender: "u1", text: "早", now: t + WINDOW_MS + 1000 }).dupe, false);
});

test("窗口外的记录会被清掉（文件不长胖）", () => {
  const root = ws();
  const t = Date.now();
  checkAndMark({ wsRoot: root, sender: "u1", text: "a", messageId: "m1", now: t });
  checkAndMark({ wsRoot: root, sender: "u1", text: "b", messageId: "m2", now: t + WINDOW_MS + 5000 });
  const keys = Object.keys(readSeen(root).seen || {});
  assert.ok(keys.length <= 2, "旧键应被清理，实际: " + keys.join(","));
});
