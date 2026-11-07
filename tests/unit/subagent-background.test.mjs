// 后台子代理端到端最小闭环（假执行器，2026-11-07）
//
// 用**假执行器**替掉真模型：这里要验的是"后台起 → 不等它 → 回传进 mailbox → continue 再跑一轮"
// 这条链，不是模型答得好不好。真的 spawnSubagent 由 tests/unit/subagent-*.test.mjs 各自负责。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobPool } from "../../engine/job-pool.mjs";
import { readMailbox } from "../../engine/agent-mailbox.mjs";
import { createSubagentBackground } from "../../engine/subagent-background.mjs";

/** 受控假执行器：每次 spawn 挂起，由测试决定什么时候、以什么结果收尾。 */
function createFakeSpawn() {
  const calls = [];
  const spawn = (params) => new Promise((resolve) => {
    const call = { params, resolve, aborted: false };
    params.signal?.addEventListener?.("abort", () => {
      call.aborted = true;
      resolve({ done: false, cancelled: true, errorCode: "cancelled", error: "子任务已取消" });
    }, { once: true });
    calls.push(call);
  });
  return { calls, spawn };
}

async function until(check, { timeoutMs = 2000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function setup({ concurrency = 2, traceHistory = null, push = null, budgetGate = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-bg-"));
  const pool = createJobPool({ file: path.join(root, "jobs.json"), concurrency });
  const fake = createFakeSpawn();
  const bg = createSubagentBackground({ wsRoot: root, pool, spawn: fake.spawn, traceHistory, push, budgetGate });
  return { root, pool, fake, bg };
}

test("后台起：立刻返回 {subagentId,status:'running',startedAt}，不等它；跑完回传进父会话", async () => {
  const { root, fake, bg } = setup();
  const started = bg.start({ task: "调研 A", sessionId: "sess-A" });

  assert.equal(started.ok, true);
  assert.match(started.subagentId, /^subagent-bg-/);
  assert.equal(started.status, "running");
  assert.equal(started.state, "running");
  assert.equal(started.queued, false);
  assert.ok(started.startedAt, "必须给出开始时间");

  // start 已经返回，但执行器还挂着——这就是"不阻塞主循环"
  const call = await until(() => fake.calls[0]);
  assert.equal(call.params.task, "调研 A");
  assert.equal(call.params.sessionId, "sess-A");
  assert.equal(bg.get(started.subagentId).status, "running");
  assert.equal(readMailbox(root).items.length, 0, "没跑完不许提前回传");

  call.resolve({ done: true, result: "结论：注入点在 _unifiedChatCore", evidence: ["engine/unified-chat.mjs:150"], subagentRunId: "trace-1" });
  await until(() => bg.get(started.subagentId).status === "done");
  await bg.whenIdle();

  const items = readMailbox(root).items;
  assert.equal(items.length, 1, "成功必须回传一条");
  assert.equal(items[0].to, "sess-A");
  assert.equal(items[0].from, `subagent:${started.subagentId}`);
  assert.match(items[0].text, /已完成/);
  assert.equal(bg.get(started.subagentId).traceId, "trace-1", "与 traces 关联");

  const note = bg.deliverReceipts({ agent: "sess-A" });
  assert.equal(note.count, 1);
  assert.equal(note.text, `【系统】子代理 ${started.subagentId} 已完成：结论：注入点在 _unifiedChatCore（未读 1 条）`);
  assert.equal(bg.unreadFor("sess-A"), 0, "注入后即已读");
  assert.equal(bg.deliverReceipts({ agent: "sess-B" }).text, "", "不是它的父会话就看不到");
});

test("续聊：done → 排队 → 再跑一轮，原任务与上一轮结论一起带过去，结束再回传", async () => {
  const { root, fake, bg } = setup();
  const started = bg.start({ task: "调研 A", context: ["背景一句"], sessionId: "sess-A" });
  const first = await until(() => fake.calls[0]);
  first.resolve({ done: true, result: "第一轮结论", subagentRunId: "trace-1" });
  await until(() => bg.get(started.subagentId).status === "done");
  bg.deliverReceipts({ agent: "sess-A" });

  const second = bg.continueSubagent({ subagentId: started.subagentId, message: "再补一个检查", sessionId: "sess-A" });
  assert.equal(second.ok, true);
  assert.equal(second.status, "running");
  assert.equal(second.subagentId, started.subagentId, "同一个子代理，不是新开一个");

  const call2 = await until(() => fake.calls[1]);
  assert.equal(call2.params.task, "再补一个检查");
  assert.equal(call2.params.sessionId, "sess-A", "父会话不变");
  assert.deepEqual(call2.params.context, ["背景一句"], "原上下文不变");
  assert.equal(call2.params.seed.length, 2, "带原任务 + 上一轮结论");
  assert.deepEqual(call2.params.seed[0], { role: "user", content: "调研 A" });
  assert.deepEqual(call2.params.seed[1], { role: "assistant", content: "第一轮结论" });
  assert.equal(bg.get(started.subagentId).continueCount, 1);
  assert.equal(bg.get(started.subagentId).status, "running");

  call2.resolve({ done: true, result: "第二轮结论", subagentRunId: "trace-2" });
  await until(() => bg.get(started.subagentId).status === "done");
  await bg.whenIdle();

  const items = readMailbox(root).items;
  assert.equal(items.length, 2, "第二轮也要回传");
  assert.match(items[0].text, /第二轮结论/);
  assert.match(items[0].text, /第 2 轮/);
  assert.equal(bg.unreadFor("sess-A"), 1, "第一条已被注入消费，只剩新的");
});

test("入口错误：不存在 / 还在跑 / 不是你的 / 已取消，都要明确报错", async () => {
  const { fake, bg } = setup();
  const missing = bg.continueSubagent({ subagentId: "subagent-bg-nope", message: "x" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "subagent_not_found");

  const started = bg.start({ task: "A", sessionId: "sess-A" });
  await until(() => fake.calls[0]);

  assert.equal(bg.continueSubagent({ subagentId: started.subagentId, message: "x", sessionId: "sess-A" }).code, "subagent_busy");
  assert.equal(bg.continueSubagent({ subagentId: started.subagentId, message: "x", sessionId: "sess-B" }).code, "not_your_subagent");
  assert.equal(bg.continueSubagent({ subagentId: started.subagentId, message: "  ", sessionId: "sess-A" }).code, "invalid_message");

  assert.equal(bg.cancel({ subagentId: started.subagentId, sessionId: "sess-A" }).ok, true);
  await until(() => bg.get(started.subagentId).status === "cancelled");
  const cancelled = bg.continueSubagent({ subagentId: started.subagentId, message: "x", sessionId: "sess-A" });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, "subagent_cancelled");
  assert.equal(bg.cancel({ subagentId: started.subagentId, sessionId: "sess-A" }).code, "illegal_transition");
});

test("失败与取消都回传（不是只在成功时通知）", async () => {
  const { root, fake, bg } = setup();

  const failing = bg.start({ task: "坏活", sessionId: "sess-A" });
  const failingCall = await until(() => fake.calls[0]);
  failingCall.resolve({ done: false, error: "上游 502", errorCode: "upstream_error" });
  await until(() => bg.get(failing.subagentId).status === "failed");
  await bg.whenIdle();

  const failingReceipt = readMailbox(root).items[0];
  assert.equal(failingReceipt.kind, "alert", "失败要标成告警");
  assert.match(failingReceipt.text, /失败/);
  assert.match(failingReceipt.text, /上游 502/);
  assert.equal(bg.get(failing.subagentId).summary, "上游 502");

  const cancelling = bg.start({ task: "长活", sessionId: "sess-A" });
  await until(() => fake.calls[1]);
  bg.cancel({ subagentId: cancelling.subagentId, sessionId: "sess-A" });
  await until(() => bg.get(cancelling.subagentId).status === "cancelled");
  await bg.whenIdle();

  const cancelledReceipt = readMailbox(root).items.find((item) => item.from === `subagent:${cancelling.subagentId}`);
  assert.ok(cancelledReceipt, "取消也要回传");
  assert.match(cancelledReceipt.text, /已取消/);
});

test("可查：list 合并登记表与 traces，带父会话/状态/起止时间/摘要/未读", async () => {
  const traces = [{
    runId: "trace-old", status: "completed", sessionId: "sess-A", role: "analyst",
    startedAt: "2026-11-07T00:00:00.000Z", endedAt: "2026-11-07T00:01:00.000Z",
    result: "同步派的旧结论", task: "旧的同步子任务",
  }];
  const { fake, bg } = setup({ traceHistory: async () => traces });

  const started = bg.start({ task: "后台任务", sessionId: "sess-A", role: "reviewer" });
  await until(() => fake.calls[0]);
  fake.calls[0].resolve({ done: true, result: "后台结论", subagentRunId: "trace-y" });
  await until(() => bg.get(started.subagentId).status === "done");

  const out = await bg.list({ sessionId: "sess-A" });
  assert.equal(out.ok, true);
  assert.equal(out.items.length, 2, "登记表一条 + traces 一条");
  const mine = out.items.find((row) => row.source === "registry");
  assert.equal(mine.id, started.subagentId);
  assert.equal(mine.parent.sessionId, "sess-A");
  assert.equal(mine.role, "reviewer");
  assert.equal(mine.status, "done");
  assert.equal(mine.summary, "后台结论");
  assert.ok(mine.startedAt && mine.endedAt);
  assert.equal(mine.unread, 1);
  const traced = out.items.find((row) => row.source === "trace");
  assert.equal(traced.id, "trace-old");
  assert.equal(traced.status, "done", "traces 的 completed 映射成 done");
  assert.match(traced.summary, /同步派的旧结论/);

  assert.equal((await bg.list({ status: "done" })).items.length, 2);
  assert.equal((await bg.list({ status: "failed" })).items.length, 0);
  assert.equal((await bg.list({ sessionId: "sess-Z" })).items.length, 0);
});

test("推送：短成功不打扰、失败必推、预算闸门拒绝时不硬推", async () => {
  const pushed = [];
  let allow = true;
  const { fake, bg } = setup({
    push: async (receipt) => { pushed.push(receipt.status); },
    budgetGate: async () => (allow ? { allowed: true } : { allowed: false, reason: "budget" }),
  });

  const quick = bg.start({ task: "快活", sessionId: "s" });
  await until(() => fake.calls[0]);
  fake.calls[0].resolve({ done: true, result: "很快" });
  await until(() => bg.get(quick.subagentId).status === "done");
  await bg.whenIdle();
  assert.deepEqual(pushed, [], "短成功不打扰人");
  assert.equal(bg.get(quick.subagentId).push, "short_run");

  const bad = bg.start({ task: "坏活", sessionId: "s" });
  await until(() => fake.calls[1]);
  fake.calls[1].resolve({ done: false, error: "超时", errorCode: "timeout" });
  await until(() => bg.get(bad.subagentId).status === "failed");
  await bg.whenIdle();
  assert.deepEqual(pushed, ["failed"], "失败必推");
  assert.equal(bg.get(bad.subagentId).push, "sent");

  allow = false;
  const blocked = bg.start({ task: "又坏一个", sessionId: "s" });
  await until(() => fake.calls[2]);
  fake.calls[2].resolve({ done: false, error: "又挂了" });
  await until(() => bg.get(blocked.subagentId).status === "failed");
  await bg.whenIdle();
  assert.deepEqual(pushed, ["failed"], "预算满了不许硬推");
  assert.equal(bg.get(blocked.subagentId).push, "budget");
});

test("并发满时先排队（queued），轮到了才 running；排队中被取消也要收尾并回传", async () => {
  const { root, fake, bg } = setup({ concurrency: 1 });
  const first = bg.start({ task: "占住唯一槽位", sessionId: "s" });
  await until(() => fake.calls[0]);

  const second = bg.start({ task: "排队等槽位", sessionId: "s" });
  assert.equal(second.status, "running", "对外契约仍然是已受理");
  assert.equal(second.state, "queued", "真实状态是排队");
  assert.equal(second.queued, true);
  assert.equal(bg.get(second.subagentId).status, "queued");

  const cancelled = bg.cancel({ subagentId: second.subagentId, sessionId: "s" });
  assert.equal(cancelled.ok, true);
  assert.equal(bg.get(second.subagentId).status, "cancelled");
  const receipt = readMailbox(root).items.find((item) => item.from === `subagent:${second.subagentId}`);
  assert.ok(receipt, "排队中被取消也要回传");
  assert.match(receipt.text, /已取消/);

  fake.calls[0].resolve({ done: true, result: "第一个结论" });
  await until(() => bg.get(first.subagentId).status === "done");
  await bg.whenIdle();
  assert.equal(fake.calls.length, 1, "已取消的排队任务不许再被拉起来跑");
});

test("重启恢复：上一进程还在跑的记录落成 interrupted 并回传，之后可以续聊", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-bg-recover-"));
  const dir = path.join(root, "记忆", "运行时");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "子代理.json"), JSON.stringify({
    v: 1,
    items: [{
      id: "subagent-bg-old", status: "running", parentSessionId: "sess-A", parentAgent: "小语",
      role: "analyst", task: "一个长活", createdAt: "2026-11-07T00:00:00.000Z", startedAt: "2026-11-07T00:00:01.000Z",
      durationMs: 0, summary: "", lastResult: "", evidence: [], error: "", errorCode: "", continueCount: 0, history: [],
    }],
  }));

  const pool = createJobPool({ file: path.join(root, "jobs.json"), concurrency: 2 });
  const bg = createSubagentBackground({ wsRoot: root, pool, spawn: async () => ({ done: true, result: "续上的结论" }) });

  assert.equal(bg.get("subagent-bg-old").status, "interrupted");
  const items = readMailbox(root).items;
  assert.equal(items.length, 1, "中断也要回传");
  assert.match(items[0].text, /已中断/);

  const cont = bg.continueSubagent({ subagentId: "subagent-bg-old", message: "接着干", sessionId: "sess-A" });
  assert.equal(cont.ok, true, "中断的子代理可以续聊");
  await until(() => bg.get("subagent-bg-old").status === "done");
  assert.equal(bg.get("subagent-bg-old").continueCount, 1);
});
