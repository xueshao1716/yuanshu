// 后台子代理：状态机 + 回传文案（纯函数，2026-11-07）
//
// 这一层是"最容易顺手改坏、又不能靠集成测试发现"的地方：
// 非法转移如果被静默放行，界面上只会看到一条莫名其妙的记录；回传如果只在成功时构造，
// 失败/取消就成了"跑完了但没人知道"。所以全部按条钉死。
import test from "node:test";
import assert from "node:assert/strict";
import {
  SUBAGENT_STATES,
  assertTransition,
  buildReceipt,
  buildReceiptNote,
  canTransition,
  filterSubagents,
  formatDuration,
  isTerminal,
  pruneRecords,
  shouldPushReceipt,
  statusLabel,
  transitionError,
} from "../../engine/subagent-state.mjs";

test("状态机：合法转移一条条通过（queued→running→终态；续聊回 queued/running）", () => {
  const legal = [
    ["queued", "running"],
    ["queued", "cancelled"],
    ["running", "done"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["running", "interrupted"],
    ["done", "queued"],          // 续聊：排队
    ["done", "running"],         // 续聊：直接开跑
    ["failed", "queued"],
    ["failed", "running"],
    ["interrupted", "running"],
  ];
  for (const [from, to] of legal) {
    assert.equal(canTransition(from, to), true, `${from} → ${to} 应合法`);
    assert.equal(assertTransition(from, to), true);
  }
  assert.equal(SUBAGENT_STATES.length, 6);
  assert.equal(isTerminal("cancelled"), true);
  assert.equal(isTerminal("running"), false);
});

test("状态机：非法转移必须抛错（code=illegal_transition），不许静默改状态", () => {
  const illegal = [
    ["cancelled", "running"],    // 用户已经让它停了
    ["cancelled", "queued"],
    ["running", "queued"],
    ["running", "running"],
    ["done", "done"],
    ["queued", "done"],          // 没跑完不能说完成
    ["queued", "failed"],
    ["done", "failed"],
    ["", "running"],
    ["unknown", "running"],
    ["running", "unknown"],
  ];
  for (const [from, to] of illegal) {
    assert.equal(canTransition(from, to), false, `${from} → ${to} 应非法`);
    assert.throws(() => assertTransition(from, to), (error) => {
      assert.equal(error.code, "illegal_transition");
      assert.equal(error.from, from);
      assert.equal(error.to, to);
      return true;
    });
  }
  assert.match(transitionError("cancelled", "running").message, /不能从/);
});

test("状态中文名：失败区分超时；未知状态原样带出", () => {
  assert.equal(statusLabel("done"), "已完成");
  assert.equal(statusLabel("failed"), "失败");
  assert.equal(statusLabel("failed", { errorCode: "timeout" }), "失败（超时）");
  assert.equal(statusLabel("cancelled"), "已取消");
  assert.equal(statusLabel("weird"), "weird");
});

test("耗时格式：毫秒 / 秒 / 分", () => {
  assert.equal(formatDuration(320), "320 毫秒");
  assert.equal(formatDuration(2300), "2.3 秒");
  assert.equal(formatDuration(60_000), "1 分");
  assert.equal(formatDuration(95_000), "1 分 35 秒");
  assert.equal(formatDuration(-5), "0 毫秒");
});

test("回传构造：成功带摘要与证据，别把干完的活写成一条空通知", () => {
  const receipt = buildReceipt({
    id: "subagent-bg-1",
    status: "done",
    task: "查一下 unified-chat 的注入点",
    result: "在 _unifiedChatCore 里 unshift system 消息即可",
    evidence: ["engine/unified-chat.mjs:150", "engine/media/api.mjs:203"],
    durationMs: 2300,
  });
  assert.equal(receipt.kind, "note");
  assert.equal(receipt.statusLabel, "已完成");
  assert.match(receipt.text, /^【子代理回执】subagent-bg-1 已完成（耗时 2\.3 秒）/);
  assert.match(receipt.text, /任务：查一下 unified-chat 的注入点/);
  assert.match(receipt.text, /摘要：/);
  assert.match(receipt.text, /证据：engine\/unified-chat\.mjs:150；engine\/media\/api\.mjs:203/);
  assert.match(receipt.title, /子代理已完成/);
  assert.equal(receipt.summary, "在 _unifiedChatCore 里 unshift system 消息即可");
  assert.ok(receipt.text.length <= 1200);
});

test("回传构造：失败（含超时）与取消都要有正文，kind 分级正确", () => {
  const failed = buildReceipt({ id: "s2", status: "failed", task: "跑个测试", error: "上游 502", errorCode: "upstream_error", durationMs: 8000 });
  assert.equal(failed.kind, "alert");
  assert.match(failed.text, /失败（耗时 8\.0 秒）/);
  assert.match(failed.text, /原因：上游 502/);
  assert.match(failed.text, /错误码：upstream_error/);

  const timeout = buildReceipt({ id: "s3", status: "failed", task: "跑个测试", error: "子任务超时", errorCode: "timeout", durationMs: 900_000 });
  assert.equal(timeout.statusLabel, "失败（超时）");
  assert.match(timeout.text, /失败（超时）/);

  const cancelled = buildReceipt({ id: "s4", status: "cancelled", task: "长活", durationMs: 1200, continueCount: 1 });
  assert.equal(cancelled.kind, "note");
  assert.match(cancelled.text, /已取消（耗时 1\.2 秒，第 2 轮）/);
  assert.match(cancelled.text, /没有结论/);
  assert.equal(cancelled.summary, "已取消");
});

test("注入文案：空表不注入；模板带未读数；最多三行、未读数用总数", () => {
  assert.equal(buildReceiptNote([], 0), "");
  assert.equal(buildReceiptNote(null, 3), "");

  const one = buildReceiptNote([{ id: "subagent-a", status: "done", summary: "查完了，结论是 X" }], 1);
  assert.equal(one, "【系统】子代理 subagent-a 已完成：查完了，结论是 X（未读 1 条）");

  const many = buildReceiptNote(
    [
      { id: "a", status: "done", summary: "一" },
      { id: "b", status: "failed", summary: "二" },
      { id: "c", status: "cancelled", summary: "三" },
      { id: "d", status: "done", summary: "不该出现" },
    ],
    7,
  ).split("\n");
  assert.equal(many.length, 3, "最多三行");
  assert.match(many[0], /^【系统】子代理 a 已完成：一（未读 7 条）$/);
  assert.match(many[1], /^【系统】子代理 b 失败：二$/);
  assert.doesNotMatch(many[1], /未读/);
  assert.match(many[2], /已取消/);
  assert.doesNotMatch(many.join("\n"), /不该出现/);
});

test("推送判断：短成功不打扰、长成功推、失败必推、取消不推", () => {
  assert.deepEqual(shouldPushReceipt({ status: "done", durationMs: 1000 }), { push: false, reason: "short_run" });
  assert.deepEqual(shouldPushReceipt({ status: "done", durationMs: 60_000 }), { push: true, reason: "long_run" });
  assert.deepEqual(shouldPushReceipt({ status: "failed", durationMs: 10 }), { push: true, reason: "failed" });
  assert.deepEqual(shouldPushReceipt({ status: "cancelled", durationMs: 60_000 }), { push: false, reason: "cancelled" });
  assert.deepEqual(shouldPushReceipt({ status: "running", durationMs: 60_000 }), { push: false, reason: "not_pushable" });
});

test("登记表裁剪：只留最近 N 条；超体积时从最旧开始丢上下文但不丢任务", () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: `r${index}`,
    startedAt: new Date(2026, 0, 1, 0, index).toISOString(),
    task: `任务 ${index}`,
    context: ["x".repeat(200)],
    lastResult: "结论",
  }));
  const kept = pruneRecords(rows, { keep: 2 });
  assert.deepEqual(kept.map((row) => row.id), ["r4", "r3"], "新的在前");

  const tight = pruneRecords(rows, { keep: 5, maxBytes: 400 });
  assert.equal(tight.length, 5);
  assert.ok(tight.some((row) => row.contextPruned === true), "超体积要丢上下文");
  assert.ok(tight.every((row) => row.task), "任务不能丢");
  assert.ok(tight.find((row) => row.contextPruned)?.context.length === 0);
});

test("列表过滤：status 逗号多值、按父会话过滤、按时间倒序", () => {
  const rows = [
    { id: "a", status: "done", parent: { sessionId: "s1" }, startedAt: "2026-11-07T01:00:00.000Z" },
    { id: "b", status: "failed", parent: { sessionId: "s1" }, startedAt: "2026-11-07T02:00:00.000Z" },
    { id: "c", status: "running", parent: { sessionId: "s2" }, startedAt: "2026-11-07T03:00:00.000Z" },
  ];
  assert.deepEqual(filterSubagents(rows, { status: "done,failed" }).map((row) => row.id), ["b", "a"]);
  assert.deepEqual(filterSubagents(rows, { sessionId: "s2" }).map((row) => row.id), ["c"]);
  assert.deepEqual(filterSubagents(rows, {}).map((row) => row.id), ["c", "b", "a"]);
  assert.deepEqual(filterSubagents(rows, { limit: 1 }).map((row) => row.id), ["c"]);
});
