// watchdog-drift 的身份补全（2026-11-07）：issue 必须能说清是哪一轮、哪个工具、失败成什么样。
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDrift } from "../../engine/watchdog-drift.mjs";

const now = Date.parse("2026-11-07T22:43:00+08:00");
const RUN = "f2170fcd-6f1c-4d80-9f25-1c72d3672d59";
const SESSION = "01a1b4f9-1aeb-7098-97c9-d37157cf4aef";
const MIN = 60_000;

const row = (o = {}) => ({
  tool: "bash",
  at: now - 20 * MIN,
  argsHash: "h1",
  ok: false,
  runId: RUN,
  session: SESSION,
  argsPreview: JSON.stringify({ command: "npm test" }),
  error: "3 failed\n[退出码 1]",
  resultPreview: "3 failed",
  ...o,
});

test("连续失败：带 run/session、时间范围、开始时间、evidence、samples", () => {
  const rows = [
    row({ at: now - 20 * MIN }),
    row({ at: now - 10 * MIN, argsHash: "h2", argsPreview: JSON.stringify({ command: "npm run build" }), error: "build 失败\n[退出码 2]" }),
    row({ at: now - 2 * MIN }),
  ];
  const res = detectDrift(rows, { now });
  assert.equal(res.drift, true);
  const issue = res.issues.find((i) => i.code === "failing");
  assert.ok(issue, "应判出连续失败");
  assert.equal(issue.runId, RUN);
  assert.equal(issue.sessionId, SESSION);
  assert.equal(issue.taskId, "");
  assert.equal(issue.tool, "bash");
  assert.equal(issue.firstAt, now - 20 * MIN);
  assert.equal(issue.lastAt, now - 2 * MIN);
  assert.equal(issue.startedAt, now - 20 * MIN);
  assert.equal(issue.evidence, `run:${RUN}`);
  assert.ok(issue.samples.length >= 1 && issue.samples.length <= 2, "samples 最多 2 条");
  assert.ok(issue.samples.every((s) => [...s].length <= 80), "每条 sample ≤80 字");
  // samples 新的在前：最近一次是 22:41 的 npm test
  assert.match(issue.samples[0], /npm test/);
  assert.match(issue.samples[0], /退出码 1/);
});

test("没有 runId/session：优雅降级为空，不报错，evidence 退到时间", () => {
  const rows = [
    row({ at: now - 20 * MIN, runId: "", session: "" }),
    row({ at: now - 10 * MIN, runId: "", session: "" }),
    row({ at: now - 2 * MIN, runId: "", session: "" }),
  ];
  const res = detectDrift(rows, { now });
  const issue = res.issues.find((i) => i.code === "failing");
  assert.ok(issue);
  assert.equal(issue.runId, "");
  assert.equal(issue.sessionId, "");
  assert.equal(issue.taskId, "");
  assert.deepEqual(issue.runIds, []);
  assert.equal(issue.firstAt, now - 20 * MIN);
  assert.equal(issue.lastAt, now - 2 * MIN);
  assert.equal(issue.startedAt, now - 20 * MIN);
  assert.match(issue.evidence, /^time:\d{2}:\d{2}-\d{2}:\d{2}$/);
  assert.ok(issue.samples.length > 0);
});

test("失败输出很长时 samples 截断到 80 字以内且带省略号", () => {
  const long = "错误信息".repeat(200);
  const rows = [
    row({ at: now - 10 * MIN, error: long, resultPreview: long }),
    row({ at: now - 5 * MIN, error: long, resultPreview: long }),
    row({ at: now - 1 * MIN, error: long, resultPreview: long }),
  ];
  const res = detectDrift(rows, { now });
  const issue = res.issues.find((i) => i.code === "failing");
  assert.ok(issue);
  assert.ok(issue.samples.length <= 2);
  for (const s of issue.samples) {
    assert.ok([...s].length <= 80, `sample 超长：${s.length}`);
    assert.match(s, /…/);
  }
});

test("空转：同参数重复也带身份与最多 2 条调用样本", () => {
  const rows = Array.from({ length: 5 }, (_, i) => row({
    at: now - (5 - i) * MIN,
    ok: true,
    error: "",
    resultPreview: "ok",
  }));
  const res = detectDrift(rows, { now });
  const issue = res.issues.find((i) => i.code === "loop");
  assert.ok(issue);
  assert.equal(issue.runId, RUN);
  assert.equal(issue.evidence, `run:${RUN}`);
  assert.ok(issue.samples.length <= 2);
  assert.match(issue.samples[0], /npm test/);
});
