// 后台子代理回传：写进 mailbox / 未读计数 / 下一轮注入（2026-11-07）
//
// 这一段是闭环里最容易断的那节："跑完了，但父会话不知道"。
// 所以既测"写进去了、发给谁、有几条没读"，也测"注入一次就该消费掉，不许每轮重复占上下文"。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inboxFor, postMessage, readMailbox } from "../../engine/agent-mailbox.mjs";
import {
  deliverSubagentReceipts,
  listUnreadSubagentReceipts,
  parentTargetOf,
  postSubagentReceipt,
  senderSubagentId,
  subagentUnreadCount,
  unreadBySubagent,
} from "../../engine/subagent-receipts.mjs";
import { buildReceipt } from "../../engine/subagent-state.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "subagent-receipts-"));

function receiptFor(id, { status = "done", result = "查完了", error = "", errorCode = "", durationMs = 2300, continueCount = 0 } = {}) {
  return buildReceipt({ id, status, task: "查一下注入点", result, error, errorCode, durationMs, continueCount });
}

test("回执落点：from=subagent:<id>、to=父会话、meta 带状态与摘要", () => {
  const root = ws();
  const id = "subagent-bg-1";
  const record = { id, status: "done", parentSessionId: "sess-A", durationMs: 2300, continueCount: 0 };
  const out = postSubagentReceipt({ wsRoot: root, record, receipt: receiptFor(id) });
  assert.equal(out.ok, true);

  const items = readMailbox(root).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].from, "subagent:subagent-bg-1");
  assert.equal(items[0].to, "sess-A");
  assert.equal(items[0].kind, "note");
  assert.equal(items[0].meta.subagentId, id);
  assert.equal(items[0].meta.status, "done");
  assert.equal(items[0].meta.summary, "查完了");
  assert.match(items[0].text, /【子代理回执】subagent-bg-1 已完成/);
  // 父会话看得见、别人看不见
  assert.equal(inboxFor(root, "sess-A").length, 1);
  assert.equal(inboxFor(root, "sess-B").length, 0);
});

test("回执落点：没有父会话时落到父 agent，绝不广播", () => {
  const root = ws();
  const record = { id: "subagent-bg-2", status: "failed", parentSessionId: "", parentAgent: "小语" };
  assert.equal(parentTargetOf(record), "小语");
  postSubagentReceipt({ wsRoot: root, record, receipt: receiptFor("subagent-bg-2", { status: "failed", error: "上游 502" }) });
  assert.equal(readMailbox(root).items[0].to, "小语");
  assert.equal(inboxFor(root, "小语").length, 1);
});

test("未读计数：只算子代理回执，人工留言不算；标记已读后归零", () => {
  const root = ws();
  postMessage({ wsRoot: root, from: "甲", to: "sess-A", text: "人工留言" });
  postSubagentReceipt({ wsRoot: root, record: { id: "a", status: "done", parentSessionId: "sess-A" }, receipt: receiptFor("a") });
  postSubagentReceipt({ wsRoot: root, record: { id: "b", status: "failed", parentSessionId: "sess-A" }, receipt: receiptFor("b", { status: "failed", error: "超时", errorCode: "timeout" }) });

  assert.equal(subagentUnreadCount(root, "sess-A"), 2, "人工留言不算子代理未读");
  assert.equal(listUnreadSubagentReceipts(root, "sess-A").length, 2);
  assert.equal(listUnreadSubagentReceipts(root, "sess-A")[0].subagentId, "b", "最新在前");
  assert.deepEqual([...unreadBySubagent(root).entries()].sort(), [["a", 1], ["b", 1]]);
});

test("注入文案：一次注入取未读并消费；再来一次不再重复", () => {
  const root = ws();
  postSubagentReceipt({ wsRoot: root, record: { id: "subagent-bg-a", status: "done", parentSessionId: "sess-A" }, receipt: receiptFor("subagent-bg-a") });

  const first = deliverSubagentReceipts({ wsRoot: root, agent: "sess-A" });
  assert.equal(first.count, 1);
  assert.equal(first.unread, 1);
  assert.equal(first.text, "【系统】子代理 subagent-bg-a 已完成：查完了（未读 1 条）");
  assert.equal(subagentUnreadCount(root, "sess-A"), 0, "注入即已读");

  const second = deliverSubagentReceipts({ wsRoot: root, agent: "sess-A" });
  assert.equal(second.text, "", "不许每轮重复注入");
});

test("注入文案：失败/取消也在里面（不是只在成功时回传）", () => {
  const root = ws();
  postSubagentReceipt({ wsRoot: root, record: { id: "f1", status: "failed", parentSessionId: "s", errorCode: "timeout" }, receipt: receiptFor("f1", { status: "failed", error: "子任务超时", errorCode: "timeout" }) });
  postSubagentReceipt({ wsRoot: root, record: { id: "c1", status: "cancelled", parentSessionId: "s" }, receipt: receiptFor("c1", { status: "cancelled" }) });

  const out = deliverSubagentReceipts({ wsRoot: root, agent: "s" });
  assert.equal(out.count, 2);
  assert.match(out.text, /子代理 c1 已取消/);
  assert.match(out.text, /子代理 f1 失败/);
  assert.match(out.text, /未读 2 条/);
});

test("边界：空 agent 不许去读默认人格的收件箱；陌生 from 不算回执", () => {
  const root = ws();
  postSubagentReceipt({ wsRoot: root, record: { id: "x", status: "done", parentSessionId: "小语" }, receipt: receiptFor("x") });
  assert.equal(deliverSubagentReceipts({ wsRoot: root, agent: "" }).text, "");
  assert.equal(deliverSubagentReceipts({ wsRoot: root, agent: "  " }).text, "");
  assert.equal(subagentUnreadCount(root, ""), 0);
  assert.equal(senderSubagentId({ from: "小语" }), "");
  assert.equal(senderSubagentId({ from: "subagent:abc" }), "abc");
});
