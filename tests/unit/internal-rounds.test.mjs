// 她自己发起的轮次（定时任务 / 后台子代理 / 值班唤醒）的"可追 id + 名字"（2026-11-07）
//
// 验收的是链路本身，不跑真模型：
//   开始（建内部 run）→ 审计行带 runId+title → 结束/失败/取消都写终态；
//   以及 titleOf 能按 id 查到名字、internal run 默认不进用户列表。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRunStore, runTitleOf } from "../../engine/run-store.mjs";
import { createAuditGate, withAuditGate } from "../../engine/tools/audit-gate.mjs";
import { createInternalRounds } from "../../engine/internal-rounds.mjs";
import { currentRound } from "../../engine/round-context.mjs";
import { createTimeEngine } from "../../engine/time-engine.mjs";
import { createJobPool } from "../../engine/job-pool.mjs";
import { createSubagentBackground } from "../../engine/subagent-background.mjs";
import { createWatchWake } from "../../engine/watch-wake.mjs";
import { detectDrift } from "../../engine/watchdog-drift.mjs";
import { composeDriftNotice } from "../../engine/drift-escalation.mjs";
import { recordDriftIncident } from "../../engine/watchdog-incidents.mjs";
import { createWatchdogReadExecutors } from "../../engine/tools/watchdog-read.mjs";

const T0 = new Date(2026, 10, 7, 22, 31, 0).getTime();
const silent = { log() {}, warn() {}, info() {}, error() {} };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ys-internal-round-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let tick = 0;
  const clock = () => T0 + (tick += 1) * 1000;
  const runStore = createRunStore({
    rootDir: root,
    now: () => new Date(clock()).toISOString(),
    idFactory: (() => { let n = 0; return () => `run-${++n}`; })(),
  });
  const auditGate = createAuditGate({ wsRoot: root, now: clock });
  const rounds = createInternalRounds({ runStore, auditGate, now: clock, ownerId: "test-instance" });
  const audited = withAuditGate(async () => ({ text: "ok" }), { gate: auditGate });
  const rowsOf = (runId) => auditGate.tail(500).filter((row) => row.runId === runId);
  const internalRuns = () => runStore.list({ includeInternal: true }).filter((run) => run.kind === "internal");
  return { root, runStore, auditGate, rounds, audited, rowsOf, internalRuns };
}

async function until(check, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("内部 run 默认不进用户列表；includeInternal 才出现；准入快照也不占用用户额度", async (t) => {
  const { runStore, rounds } = fixture(t);
  const round = rounds.begin({ kind: "time", refId: "task-1", label: "每日复盘" });
  assert.ok(round?.runId, "必须拿到可追 id");
  assert.match(round.runId, /^rt-/);
  assert.equal(round.title, "每日复盘");

  assert.deepEqual(runStore.list(), [], "默认列表看不到内部轮次");
  assert.deepEqual(await runStore.listAsync(), [], "默认时间线也看不到");
  assert.deepEqual(await runStore.listActivity(), [], "活动指示器也不把内部轮次算成用户在跑");
  assert.equal(runStore.list({ includeInternal: true }).length, 1);
  assert.equal((await runStore.listAsync({ includeInternal: true })).length, 1);
  assert.deepEqual(runStore.readAdmissionSnapshot(), [], "内部轮次不占用户 run 的并发额度");

  const stored = runStore.get(round.runId);
  assert.equal(stored.kind, "internal");
  assert.equal(stored.internalKind, "time");
  assert.equal(stored.refId, "task-1");
  assert.equal(stored.title, "每日复盘");

  round.finish("completed");
  const done = runStore.get(round.runId);
  assert.equal(done.status, "completed");
  assert.ok(done.endedAt && done.completedAt, "结束要写终态时间");
  // 幂等：重复收尾不覆盖已写好的终态
  round.finish("failed", { error: "late" });
  assert.equal(runStore.get(round.runId).status, "completed");
});

test("titleOf 能按 id 查到三类轮次的名字（label / subagent name / watch name）", (t) => {
  const { runStore, rounds } = fixture(t);
  const time = rounds.begin({ kind: "time", label: "每日复盘" });
  const agent = rounds.begin({ kind: "subagent", name: "登录页回归" });
  const watch = rounds.begin({ kind: "watch", name: "CI 守卫" });
  assert.equal(runTitleOf(runStore, time.runId), "每日复盘");
  assert.equal(runTitleOf(runStore, agent.runId), "登录页回归");
  assert.equal(runTitleOf(runStore, watch.runId), "CI 守卫");
  assert.equal(runTitleOf(runStore, "rt-not-exist"), "", "查不到就留空，不猜");
  // 老用户 run 的兜底也走同一条查询，不能被内部轮次挤掉
  const legacy = runStore.create({ sessionId: "s-legacy", clientRequestId: "c-legacy", message: "请帮我整理截图" });
  assert.equal(runTitleOf(runStore, legacy.id), "整理截图");
});

test("定时任务：开始建内部 run → 审计行带 id+title → 成功收尾 completed", async (t) => {
  const { root, runStore, rounds, audited, rowsOf, internalRuns } = fixture(t);
  const seen = [];
  const engine = createTimeEngine(async () => {
    seen.push(currentRound());
    await audited("bash", { command: "npm test" }, {});
    return "复盘完成";
  }, { file: path.join(root, "time-tasks.json"), rounds });

  const { id } = engine.register({ prompt: "每日复盘", label: "每日复盘" });
  const out = await engine.runNow(id);
  assert.equal(out.ok, true);

  const [run] = internalRuns();
  assert.ok(run, "定时任务必须留下内部 run");
  assert.equal(run.status, "completed");
  assert.equal(run.title, "每日复盘");
  assert.equal(run.internalKind, "time");
  assert.equal(run.refId, id);
  assert.equal(seen[0]?.runId, run.id, "执行器里能拿到这一轮的 id");
  assert.equal(seen[0]?.title, "每日复盘");

  const rows = rowsOf(run.id);
  const before = rows.find((row) => row.phase === "before" && row.tool === "bash");
  assert.ok(before, "工具调用审计行必须带这一轮的 runId");
  assert.equal(before.title, "每日复盘", "审计行必须带名字");
  assert.equal(before.session, run.sessionId);
  assert.equal(rows.find((row) => row.phase === "round_start")?.title, "每日复盘");
  const end = rows.find((row) => row.phase === "round_end");
  assert.equal(end?.ok, true);
  assert.equal(end?.runId, run.id);
  assert.equal(end?.title, "每日复盘");
  assert.equal(engine.find(id).history[0].runId, run.id, "执行历史也记下可追 id");
});

test("定时任务失败/被停：内部 run 分别写 failed / stopped 终态", async (t) => {
  const { root, runStore, rounds, internalRuns } = fixture(t);

  const failing = createTimeEngine(async () => { throw new Error("上游 502"); },
    { file: path.join(root, "time-fail.json"), rounds });
  const bad = failing.register({ prompt: "夜间反思", label: "夜间反思" });
  await failing.runNow(bad.id);
  const failedRun = internalRuns().find((run) => run.refId === bad.id);
  assert.equal(failedRun.status, "failed");
  assert.match(failedRun.error, /上游 502/);
  assert.equal(failedRun.title, "夜间反思");

  let aborted = false;
  const slow = createTimeEngine((_task, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      const error = new Error("已停止");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  }), { file: path.join(root, "time-stop.json"), rounds });
  const long = slow.register({ prompt: "长活", label: "长活" });
  const pending = slow.runNow(long.id);
  await until(() => slow.list().find((task) => task.id === long.id)?.running);
  slow.stopRun(long.id);
  await pending;
  assert.equal(aborted, true);
  const stoppedRun = internalRuns().find((run) => run.refId === long.id);
  assert.equal(stoppedRun.status, "stopped");
  assert.ok(stoppedRun.stoppedAt, "取消也要写终态时间");
});

test("后台子代理：内部 run 用 subagent name 作标题，审计行带 id+title，取消收尾 stopped", async (t) => {
  const { root, runStore, rounds, audited, rowsOf, internalRuns } = fixture(t);
  const seen = [];
  const spawn = async (params) => {
    seen.push(currentRound());
    await audited("read", { path: "README.md" }, {});
    if (params.task.includes("坏")) return { done: false, error: "上游 502", errorCode: "upstream_error" };
    if (params.task.includes("取消")) {
      // 取消可能发生在审计之后、监听注册之前：先看已经 abort 的状态，再等事件。
      if (!params.signal.aborted) {
        await new Promise((resolve) => params.signal.addEventListener("abort", resolve, { once: true }));
      }
      return { done: false, cancelled: true, errorCode: "cancelled", error: "子任务已取消" };
    }
    return { done: true, result: "结论是没问题", subagentRunId: "trace-1" };
  };
  const pool = createJobPool({ file: path.join(root, "jobs.json"), concurrency: 2 });
  const bg = createSubagentBackground({ wsRoot: root, pool, spawn, rounds });

  const started = bg.start({ task: "查登录页回归", name: "登录页回归", sessionId: "sess-A" });
  await until(() => bg.get(started.subagentId).status === "done");
  const run = internalRuns().find((row) => row.refId === started.subagentId);
  assert.ok(run, "后台子代理必须留下内部 run");
  assert.equal(run.status, "completed");
  assert.equal(run.title, "登录页回归");
  assert.equal(run.internalKind, "subagent");
  assert.equal(seen[0]?.runId, run.id);
  assert.equal(bg.get(started.subagentId).internalRunId, run.id);
  const before = rowsOf(run.id).find((row) => row.phase === "before" && row.tool === "read");
  assert.equal(before?.title, "登录页回归");
  assert.equal(rowsOf(run.id).find((row) => row.phase === "round_end")?.ok, true);

  const failing = bg.start({ task: "坏活", name: "坏活", sessionId: "sess-A" });
  await until(() => bg.get(failing.subagentId).status === "failed");
  const failedRun = internalRuns().find((row) => row.refId === failing.subagentId);
  assert.equal(failedRun.status, "failed");
  assert.match(failedRun.error, /上游 502/);

  const cancelling = bg.start({ task: "取消活", name: "取消活", sessionId: "sess-A" });
  await until(() => bg.get(cancelling.subagentId).status === "running");
  await until(() => seen.length >= 3);
  bg.cancel({ subagentId: cancelling.subagentId, sessionId: "sess-A" });
  await until(() => bg.get(cancelling.subagentId).status === "cancelled");
  const cancelledRun = internalRuns().find((row) => row.refId === cancelling.subagentId);
  assert.equal(cancelledRun.status, "stopped", "取消要收尾成终态");
});

test("值班唤醒：内部 run 用 watch name 作标题，成功/失败/取消都收尾", async (t) => {
  const { root, runStore, rounds, audited, rowsOf, internalRuns } = fixture(t);
  const jobs = [];
  let seq = 0;
  const jobPool = {
    submit(meta, run) {
      const job = { id: `j-${++seq}`, ...meta, run };
      jobs.push(job);
      return job;
    },
  };
  let mode = "ok";
  const seen = [];
  const wake = createWatchWake({
    wsRoot: root,
    jobPool,
    rounds,
    logFile: path.join(root, "值班日志.jsonl"),
    now: () => T0,
    log: silent,
    notifier: { notify: async () => ({ ok: true }) },
    postMessage: () => ({ ok: true }),
    runTurn: async () => {
      seen.push(currentRound());
      await audited("read", { path: "a.md" }, {});
      if (mode === "fail") throw new Error("上游 502");
      return { text: "查过了，没事" };
    },
  });

  wake({ watch: { id: "w1", name: "CI 守卫", kind: "cmd", prompt: "p" }, hit: { reason: "退出码非 0" } });
  await jobs[0].run(new AbortController().signal);
  const [run] = internalRuns();
  assert.ok(run, "值班唤醒必须留下内部 run");
  assert.equal(run.status, "completed");
  assert.equal(run.title, "CI 守卫");
  assert.equal(run.internalKind, "watch");
  assert.equal(run.refId, "w1");
  assert.equal(seen[0]?.runId, run.id);
  const before = rowsOf(run.id).find((row) => row.phase === "before" && row.tool === "read");
  assert.equal(before?.title, "CI 守卫");
  assert.equal(rowsOf(run.id).find((row) => row.phase === "round_end")?.ok, true);

  mode = "fail";
  wake({ watch: { id: "w2", name: "夜巡", kind: "cmd", prompt: "p" }, hit: { reason: "命中" } });
  await assert.rejects(() => jobs[1].run(new AbortController().signal), /上游 502/);
  const failedRun = internalRuns().find((row) => row.refId === "w2");
  assert.equal(failedRun.status, "failed");
  assert.match(failedRun.error, /上游 502/);

  mode = "ok";
  wake({ watch: { id: "w3", name: "取消的值班", kind: "cmd", prompt: "p" }, hit: { reason: "命中" } });
  const aborted = new AbortController();
  aborted.abort();
  await jobs[2].run(aborted.signal);
  const stoppedRun = internalRuns().find((row) => row.refId === "w3");
  assert.equal(stoppedRun.status, "stopped", "取消要按 stopped 收尾");
});

test("看门狗串起来：定时任务的审计行 → issue 带 runId+title → 通知与 watchdog_read 都说得清", async (t) => {
  const { root, runStore, auditGate, rounds } = fixture(t);
  const failExec = withAuditGate(async () => ({ text: "3 failed\n[退出码 1]", isError: true }), { gate: auditGate });
  const round = rounds.begin({ kind: "time", refId: "task-42", label: "每日复盘" });
  await round.enter(async () => {
    for (let i = 0; i < 3; i += 1) await failExec("bash", { command: "npm test" }, {});
  });
  round.finish("failed", { error: "连续失败" });

  const rows = auditGate.tail(100);
  const now = T0 + 120_000;
  const res = detectDrift(rows, { now, titleOf: (runId) => runTitleOf(runStore, runId) });
  const issue = res.issues.find((item) => item.code === "failing" && item.runId === round.runId);
  assert.ok(issue, "issue 要指认到这一轮");
  assert.equal(issue.title, "每日复盘");
  assert.ok(issue.runId);

  const notice = composeDriftNotice(res.issues, { incidentId: "drift-test" });
  assert.match(notice, /每日复盘（run rt-/);
  assert.match(notice, new RegExp(round.runId.slice(0, 8)));
  assert.match(notice, /bash 连续失败 3 次/);

  const saved = recordDriftIncident(root, res, { now, rows });
  assert.equal(saved.ok, true);
  const read = createWatchdogReadExecutors({ wsRoot: root }).watchdog_read({ id: saved.incident.id });
  assert.equal(read.isError, false);
  assert.match(read.text, /任务「每日复盘」/);
  assert.match(read.text, new RegExp(round.runId.slice(0, 8)));
  assert.match(read.text, /bash 连续失败 3 次/);
});

test("审计门：没有内部轮次上下文时行为不变（runId/title 仍可由 ctx 显式提供）", async (t) => {
  const { auditGate } = fixture(t);
  const exec = withAuditGate(async () => ({ text: "ok" }), { gate: auditGate });
  await exec("bash", { command: "echo hi" }, { runId: "user-run-1", sessionId: "s1" });
  const rows = auditGate.tail(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].runId, "user-run-1");
  assert.equal(rows[0].title, undefined, "用户 run 没有显式 title 时不多写字段");
});

test("审计门 round() 边界行：id/title 必带，且 argsHash 每轮唯一，不会被当成空转", async (t) => {
  const { auditGate, rounds } = fixture(t);
  const a = rounds.begin({ kind: "time", label: "A 任务" });
  const b = rounds.begin({ kind: "watch", name: "B 值班" });
  a.finish("completed");
  b.finish("failed", { error: "boom" });
  const rows = auditGate.tail(50).filter((row) => row.tool === "internal_round");
  assert.equal(rows.length, 4);
  const starts = rows.filter((row) => row.phase === "round_start");
  assert.equal(new Set(starts.map((row) => row.argsHash)).size, 2, "每轮 argsHash 不同");
  for (const row of rows) {
    assert.ok(row.runId && row.title, `边界行必须带 id+title：${JSON.stringify(row)}`);
  }
  assert.equal(rows.find((row) => row.phase === "round_end" && row.runId === b.runId).ok, false);
});
