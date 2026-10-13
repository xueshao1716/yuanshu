// feedback store：收件箱行为契约（提交/列表/标记/脱敏边界），2026-10-13
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFeedbackStore } from "../../engine/feedback.mjs";

function tmpWs() {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-feedback-"));
  t.after?.(() => {});
  return wsRoot;
}

test("feedback：提交→列表→标记 全链路", () => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-feedback-"));
  const store = createFeedbackStore({ wsRoot, version: "2.127.10" });
  const r = store.add({ type: "bug", title: "打不开设置页", detail: "点按钮没反应", withDiagnostics: true });
  assert.ok(r.item?.id, "返回 id");
  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "open");
  assert.ok(items[0].diagnostics, "请求诊断则附带");
  assert.equal(items[0].diagnostics.version, "2.127.10");
  const m = store.mark(items[0].id, "done");
  assert.equal(m.item.status, "done");
  assert.ok(store.list()[0].handledAt);
  fs.rmSync(wsRoot, { recursive: true, force: true });
});

test("feedback：类型纠偏与校验拒绝", () => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-feedback-"));
  const store = createFeedbackStore({ wsRoot, version: "" });
  assert.ok(store.add({ type: "bug", title: "" }).error, "空标题拒绝");
  const r = store.add({ type: "不是类型", title: "x" });
  assert.equal(r.item.type, "idea", "未知类型落回 idea");
  const bad = store.mark("no-such-id", "done");
  assert.equal(bad.error, "not_found");
  assert.equal(store.mark("no-such-id", "炸了").error, "invalid_status");
  fs.rmSync(wsRoot, { recursive: true, force: true });
});

test("feedback：超长截断与持久化（重启后仍在）", () => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-feedback-"));
  const store = createFeedbackStore({ wsRoot, version: "" });
  store.add({ type: "idea", title: "标".repeat(500), detail: "详".repeat(20000) });
  const items = store.list();
  assert.equal(items[0].title.length, 120, "标题截到 120");
  assert.equal(items[0].detail.length, 8000, "详情截到 8000");
  // 新实例（模拟重启）读同一文件
  const store2 = createFeedbackStore({ wsRoot, version: "" });
  assert.equal(store2.list().length, 1, "重启后收件箱仍在");
  fs.rmSync(wsRoot, { recursive: true, force: true });
});
