// 打开长会话：当前枝 leafId + 尾部窗口，避免把整棵分支树和 5MB JSON 甩给手机
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractMessages, extractImages, resolveLeafId, windowMessages } from "../../engine/session/utils.mjs";

function msg(id, parentId, role, text, ts = "2026-09-01T00:00:00.000Z") {
  return { type: "message", id, parentId, timestamp: ts, message: { role, content: text } };
}

test("resolveLeafId：未指定时落到最新一条消息（当前枝）", () => {
  const entries = [
    { type: "session", id: "s" },
    msg("m1", null, "user", "问A"),
    msg("m2", "m1", "assistant", "答A"),
    msg("m3", "m1", "assistant", "分叉答"),
  ];
  assert.equal(resolveLeafId(entries, null), "m3");
  assert.equal(resolveLeafId(entries, "m2"), "m2");
  assert.equal(resolveLeafId(entries, "nope"), "m3");
});

test("extractMessages 带 leafId 只返回当前枝，不含兄弟分叉", () => {
  const entries = [
    msg("m1", null, "user", "问A"),
    msg("m2", "m1", "assistant", "答A"),
    msg("m3", "m1", "assistant", "分叉答"),
  ];
  const branch = extractMessages(entries, "m3");
  assert.deepEqual(branch.map(m => m.id), ["m1", "m3"]);
  const all = extractMessages(entries, null);
  assert.deepEqual(all.map(m => m.id), ["m1", "m2", "m3"]);
});

test("windowMessages：tail 只留尾部，truncated/total 给前端加载更早", () => {
  const msgs = Array.from({ length: 5 }, (_, i) => ({ id: "m" + i, text: String(i) }));
  const none = windowMessages(msgs, 0);
  assert.equal(none.truncated, false);
  assert.equal(none.messages.length, 5);
  const win = windowMessages(msgs, 2);
  assert.equal(win.truncated, true);
  assert.equal(win.total, 5);
  assert.deepEqual(win.messages.map(m => m.id), ["m3", "m4"]);
});

test("extractImages 认 url 出图块，extractMessages 交给前端的是 URL 字符串", () => {
  const url = "/api/ws/file?path=%E4%BA%A7%E7%89%A9.png";
  const imgs = extractImages([{ type: "text", text: "画好了" }, { type: "image", url }]);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].url, url);
  const entries = [{
    type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-05T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "画好了" }, { type: "image", url }] },
  }];
  const msgs = extractMessages(entries, null);
  assert.equal(msgs[0].text, "画好了");
  assert.deepEqual(msgs[0].images, [url]);
});

test("extractMessages 认 video 块，刷新后还能播", () => {
  const url = "/api/ws/file?path=%E7%88%B1%E8%80%8C%E4%B8%8D%E5%BE%97.mp4";
  const entries = [{
    type: "message", id: "v1", parentId: "u1", timestamp: "2026-09-06T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "片做好了" }, { type: "video", url }] },
  }];
  const msgs = extractMessages(entries, null);
  assert.equal(msgs[0].text, "片做好了");
  assert.deepEqual(msgs[0].videos, [url]);
});

test("GET /messages 默认走当前枝 + tail 窗", () => {
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "server.mjs"), "utf8");
  const fn = server.split("async function handleMessages")[1]?.split("async function")[0] || "";
  assert.ok(fn.includes("resolveLeafId"), "必须解析当前枝 leafId");
  assert.ok(fn.includes("windowMessages"), "必须裁尾窗");
  assert.ok(fn.includes("truncated"), "响应必须带 truncated 供加载更早");
});
