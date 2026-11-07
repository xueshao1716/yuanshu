// 看门狗用上 run 的 title（2026-11-07）：issue 带上「是哪件事」，
// 推送与 watchdog_read 都说得出任务名；查不到时明说「这轮没带名字」，不猜。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectDrift } from "../../engine/watchdog-drift.mjs";
import { composeDriftNotice } from "../../engine/drift-escalation.mjs";
import { recordDriftIncident } from "../../engine/watchdog-incidents.mjs";
import { createWatchdogReadExecutors } from "../../engine/tools/watchdog-read.mjs";

const at = (h, m, s = 0) => new Date(2026, 10, 7, h, m, s).getTime();
const NOW = at(22, 43);
const RUN = "f2170fcd-6f1c-4d80-9f25-1c72d3672d59";
const SESSION = "01a1b4f9-1aeb-7098-97c9-d37157cf4aef";
const TITLE = "整理桌面截图";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ys-wd-title-"));

const row = (o = {}) => ({
  tool: "bash",
  at: at(22, 31, 45),
  argsHash: "h1",
  ok: false,
  runId: RUN,
  session: SESSION,
  argsPreview: JSON.stringify({ command: "npm test" }),
  error: "3 failed\n[退出码 1]",
  resultPreview: "3 failed",
  ...o,
});

const failureRows = () => [
  row({ at: at(22, 31, 45), argsHash: "h1" }),
  row({ at: at(22, 33, 51), argsHash: "h2" }),
  row({ at: at(22, 34, 10), argsHash: "h3" }),
];

test("detectDrift 用注入的 titleOf 给 issue 补上任务名（查询参数是 runId）", () => {
  const asked = [];
  const res = detectDrift(failureRows(), {
    now: NOW,
    titleOf: (runId) => { asked.push(runId); return runId === RUN ? TITLE : ""; },
  });
  const issue = res.issues.find((i) => i.code === "failing");
  assert.ok(issue);
  assert.equal(issue.title, TITLE);
  assert.equal(issue.runId, RUN);
  assert.deepEqual(asked, [RUN]);
});

test("rows 自带 title 时优先用行里的，不再查 store", () => {
  let asked = 0;
  const res = detectDrift(
    failureRows().map((r) => ({ ...r, title: "行内任务名" })),
    { now: NOW, titleOf: () => { asked += 1; return TITLE; } },
  );
  const issue = res.issues.find((i) => i.code === "failing");
  assert.equal(issue.title, "行内任务名");
  assert.equal(asked, 0);
});

test("查不到 / 查询抛错 / 没有 runId：title 留空，判断本身不受影响", () => {
  const missing = detectDrift(failureRows(), { now: NOW, titleOf: () => "" });
  assert.equal(missing.issues.find((i) => i.code === "failing").title, "");

  const broken = detectDrift(failureRows(), { now: NOW, titleOf: () => { throw new Error("disk"); } });
  assert.equal(broken.issues.find((i) => i.code === "failing").title, "");

  let asked = 0;
  const noId = detectDrift(
    failureRows().map((r) => ({ ...r, runId: "" })),
    { now: NOW, titleOf: () => { asked += 1; return TITLE; } },
  );
  assert.equal(noId.issues.find((i) => i.code === "failing").title, "");
  assert.equal(asked, 0, "没有 runId 时不该乱查");
});

test("title 超长时按 40 字截断（与 run 记录同一上限）", () => {
  const res = detectDrift(failureRows(), { now: NOW, titleOf: () => "任务名".repeat(40) });
  const issue = res.issues.find((i) => i.code === "failing");
  assert.equal([...issue.title].length, 40);
  assert.ok(issue.title.endsWith("…"));
});

test("推送正文：有名字先说名字，再给 run id 与开始时间", () => {
  const res = detectDrift(failureRows(), { now: NOW, titleOf: () => TITLE });
  const text = composeDriftNotice(res.issues, { incidentId: "drift-20261107T224354-abc123" });
  assert.match(text, new RegExp(`· 任务：${TITLE}（run f2170fcd，22:31）`));
  assert.match(text, /bash 连续失败 3 次/);
  assert.match(text, /npm test/);
  assert.match(text, /\/api\/watchdog\/drift\/drift-20261107T224354-abc123/);
  assert.doesNotMatch(text, /这轮没带名字/);
});

test("推送正文降级：没有名字时退回旧写法，并明说「这轮没带名字」", () => {
  const res = detectDrift(failureRows(), { now: NOW, titleOf: () => "" });
  const text = composeDriftNotice(res.issues, { incidentId: "drift-x" });
  assert.match(text, /· 任务：run f2170fcd（22:31 开始，这轮没带名字）/);
  assert.match(text, /bash 连续失败 3 次/);
  assert.match(text, /继续/);
});

test("watchdog_read：事件里存了 title 就转述任务名", () => {
  const ws = tmp();
  const res = detectDrift(failureRows(), { now: NOW, titleOf: () => TITLE });
  const incident = recordDriftIncident(ws, res, { now: NOW, rows: failureRows() }).incident;
  const out = createWatchdogReadExecutors({ wsRoot: ws }).watchdog_read({ id: incident.id });
  assert.equal(out.isError, false);
  assert.match(out.text, /22:31 开始的那一轮/);
  assert.match(out.text, /run f2170fcd/);
  assert.match(out.text, /任务「整理桌面截图」/);
  assert.match(out.text, /bash 连续失败 3 次/);
  assert.match(out.text, /npm test/);
});

test("watchdog_read 降级：没有 title 时仍说得出哪一轮，只是没有任务名", () => {
  const ws = tmp();
  const res = detectDrift(failureRows(), { now: NOW, titleOf: () => "" });
  const incident = recordDriftIncident(ws, res, { now: NOW, rows: failureRows() }).incident;
  const out = createWatchdogReadExecutors({ wsRoot: ws }).watchdog_read({ id: incident.id });
  assert.equal(out.isError, false);
  assert.match(out.text, /22:31 开始的那一轮/);
  assert.match(out.text, /run f2170fcd/);
  assert.doesNotMatch(out.text, /任务「/);
  assert.match(out.text, /bash 连续失败 3 次/);
});

test("串起来：detectDrift → 事件 → watchdog_read 最近一条也带名字", () => {
  const ws = tmp();
  const res = detectDrift(failureRows(), { now: NOW, titleOf: () => TITLE });
  const saved = recordDriftIncident(ws, res, { now: NOW, rows: failureRows() });
  assert.equal(saved.ok, true);
  const out = createWatchdogReadExecutors({ wsRoot: ws }).watchdog_read();
  assert.match(out.text, new RegExp(saved.incident.id));
  assert.match(out.text, /任务「整理桌面截图」/);
});
