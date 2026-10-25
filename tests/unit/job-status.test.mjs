// job_status 工具 + 待汇报台账（2026-10-25）
// 用户的诉求："我先忙，她做完汇报，结果没有汇报"——要有状态机能回答"做没做完、坏在哪步、报没报过"。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectJobs, summarizeJobs, syncReports, pendingReports, pendingReportsLine, ackReports,
  STALL_MS,
} from "../../engine/job-state.mjs";

function tmpWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-"));
  fs.mkdirSync(path.join(root, "记忆", "运行时"), { recursive: true });
  return root;
}

const now = 10_000_000;

test("三类来源统一成状态机：done / failed / running / stalled", () => {
  const jobs = collectJobs({
    now,
    detached: [
      { id: "d-ok", label: "渲染", alive: false, done: true, exitCode: 0, startedAt: now - 5000, elapsedMs: 5000 },
      { id: "d-bad", label: "编码", alive: false, done: true, exitCode: 1, startedAt: now - 5000, elapsedMs: 5000 },
      { id: "d-running", label: "在跑", alive: true, done: false, startedAt: now - 1000 },
      { id: "d-stall", label: "卡住", alive: true, done: false, startedAt: now - STALL_MS * 2 },
    ],
    runs: [
      // background: true —— 普通对话轮（8 秒）不算后台作业，只有标了后台或跑超 2 分钟才算
      { id: "r-ok", status: "completed", title: "导出", background: true, startedAt: now - 9000, updatedAt: now - 1000 },
      { id: "r-bad", status: "failed", title: "转码", background: true, startedAt: now - 9000, updatedAt: now - 1000, error: "ffmpeg 挂了" },
    ],
    tasks: [{ id: "t1", label: "反思", history: [{ startedAt: now - 3000, durationMs: 2000, status: "ok" }] }],
  });
  const byId = Object.fromEntries(jobs.map((j) => [j.id, j.state]));
  assert.equal(byId["d-ok"], "done");
  assert.equal(byId["d-bad"], "failed");
  assert.equal(byId["d-running"], "running");
  assert.equal(byId["d-stall"], "stalled", "超过 STALL_MS 没动静就是卡住，不是还在跑");
  assert.equal(byId["r-ok"], "done");
  assert.equal(byId["r-bad"], "failed");
  assert.equal(byId["task:t1"], "done");
  assert.deepEqual(summarizeJobs(jobs), { done: 3, failed: 2, running: 1, stalled: 1, total: 7 });
});

test("只有 done/failed 进待汇报；在跑和卡住的不进（避免刷屏）", () => {
  const ws = tmpWs();
  const jobs = collectJobs({
    now,
    detached: [
      { id: "ok", label: "渲染", alive: false, done: true, exitCode: 0, startedAt: now - 1000 },
      { id: "run", label: "在跑", alive: true, done: false, startedAt: now - 1000 },
    ],
  });
  const added = syncReports(ws, jobs, { now });
  assert.deepEqual(added, ["ok"]);
  assert.equal(pendingReports(ws, { now }).length, 1);
});

test("重复同步不会重复记；ack 之后不再提醒", () => {
  const ws = tmpWs();
  const jobs = collectJobs({ now, detached: [{ id: "ok", label: "渲染", alive: false, done: true, exitCode: 0, startedAt: now - 1000 }] });
  syncReports(ws, jobs, { now });
  syncReports(ws, jobs, { now: now + 1000 });
  assert.equal(pendingReports(ws, { now }).length, 1, "同一个作业只记一条");

  assert.equal(ackReports(ws, ["ok"], { note: "已经告诉对方了" }).acked, 1);
  assert.equal(pendingReports(ws, { now }).length, 0);
  assert.equal(pendingReportsLine(ws, { now }), "", "报过了就不该再占提示词");
});

test("待汇报那句话能说清：几个、什么状态、卡在哪一步", () => {
  const ws = tmpWs();
  const jobs = collectJobs({
    now,
    detached: [{ id: "bad", label: "转码 45 秒影片", alive: false, done: true, exitCode: 1, startedAt: now - 1000 }],
    runs: [{ id: "r1", status: "failed", title: "导出", background: true, error: "磁盘满", updatedAt: now - 500, startedAt: now - 9000 }],
  });
  syncReports(ws, jobs, { now });
  const line = pendingReportsLine(ws, { now });
  assert.match(line, /未汇报/);
  assert.match(line, /2 个/, "要说清数量");
  assert.match(line, /转码 45 秒影片/);
  assert.match(line, /job_status/, "要告诉她用哪个工具查细节");
});

test("没有待汇报时不产生任何提示词负担", () => {
  assert.equal(pendingReportsLine(tmpWs(), { now }), "");
});

test("ack 只认 id，不会误清别的", () => {
  const ws = tmpWs();
  const jobs = collectJobs({
    now,
    detached: [
      { id: "a", label: "A", alive: false, done: true, exitCode: 0, startedAt: now - 1000 },
      { id: "b", label: "B", alive: false, done: true, exitCode: 0, startedAt: now - 1000 },
    ],
  });
  syncReports(ws, jobs, { now });
  ackReports(ws, ["a"]);
  const left = pendingReports(ws, { now }).map((x) => x.id);
  assert.deepEqual(left, ["b"]);
});
