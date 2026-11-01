// ask 回执闭环：待办、回执解析、结单、免打扰（2026-11-01）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAsk, listAsks, parseReply, pickAsk, resolveAsk, handleReply, quietHours, EXPIRE_MS, pendingFile } from "../../engine/router-pending.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "ask-"));

test("建待办 + 列出", () => {
  const root = ws();
  const row = createAsk(root, { source: "wechat", text: "删 12 张原图", reason: "删数据", task: "删 生成物/图片 下原图" });
  assert.match(row.id, /^ask-/);
  assert.equal(row.state, "pending");
  const list = listAsks(root, { state: "pending" });
  assert.equal(list.length, 1);
  assert.ok(fs.existsSync(pendingFile(root)));
});

test("过期自动标 expired", () => {
  const root = ws();
  const now = Date.now();
  createAsk(root, { text: "老事", reason: "x", now: now - EXPIRE_MS - 1000 });
  const list = listAsks(root, { state: "pending", now });
  assert.equal(list.length, 0);
  assert.equal(listAsks(root, { state: "expired", now }).length, 1);
});

test("回执解析：同意 / 拒绝 / 含糊", () => {
  assert.equal(parseReply("删吧").kind, "approve");
  assert.equal(parseReply("可以，做").kind, "approve");
  assert.equal(parseReply("算了不用").kind, "deny");
  assert.equal(parseReply("再想想").kind, "unclear");
  assert.equal(parseReply("今天天气不错").kind, "unclear");
});

test("单条待办：一句话就对上", () => {
  const root = ws();
  createAsk(root, { text: "删 12 张原图", reason: "删数据" });
  assert.equal(pickAsk(root, "删吧").text, "删 12 张原图");
});

test("多条待办：按关键词挑最像的", () => {
  const root = ws();
  createAsk(root, { text: "删除 生成物 原图", reason: "删数据" });
  createAsk(root, { text: "对外发布 项目分享", reason: "对外" });
  const hit = pickAsk(root, "那就发布吧");
  assert.match(hit.text, /对外发布/);
});

test("handleReply：同意 → approved；再处理一次不会重复", () => {
  const root = ws();
  const row = createAsk(root, { text: "删原图", reason: "删数据", task: "删吧" });
  const a = handleReply(root, "删吧");
  assert.equal(a.handled, true);
  assert.equal(a.kind, "approve");
  assert.equal(a.ask.state, "approved");
  const b = handleReply(root, "删吧");
  assert.equal(b.handled, false);
});

test("handleReply：拒绝 → denied", () => {
  const root = ws();
  createAsk(root, { text: "删原图", reason: "删数据" });
  const r = handleReply(root, "算了，别删");
  assert.equal(r.kind, "deny");
  assert.equal(r.ask.state, "denied");
});

test("handleReply：没有待办时不当回执处理", () => {
  const root = ws();
  const r = handleReply(root, "可以");
  assert.equal(r.handled, false);
  assert.match(r.reason, /没有待拍板/);
});

test("resolveAsk：找不到 / 重复结单会报错", () => {
  const root = ws();
  assert.equal(resolveAsk(root, "nope").ok, false);
  const row = createAsk(root, { text: "x", reason: "y" });
  assert.equal(resolveAsk(root, row.id, { state: "approved" }).ok, true);
  assert.match(resolveAsk(root, row.id, { state: "approved" }).error, /已经是/);
});

test("免打扰：0–7 点默认不推，社交权重很高才推", () => {
  const night = new Date("2026-11-01T03:00:00");
  const day = new Date("2026-11-01T15:00:00");
  assert.equal(quietHours(night.getTime(), 0.5), true);
  assert.equal(quietHours(night.getTime(), 0.9), false);
  assert.equal(quietHours(day.getTime(), 0.1), false);
});
