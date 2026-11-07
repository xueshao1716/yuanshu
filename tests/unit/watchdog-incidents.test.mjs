// 看门狗跑偏事件（2026-11-07）：带 id、落盘、按 id 取、只留最近 50 条。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordDriftIncident, latestDriftIncident, getDriftIncident, listDriftIncidents,
  incidentsFile, MAX_INCIDENTS,
} from "../../engine/watchdog-incidents.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ys-drift-inc-"));
const base = Date.parse("2026-11-07T22:43:54+08:00");
const RESULT = {
  drift: true,
  issues: [{
    code: "failing", detail: "bash 连续失败 3 次", n: 3, tool: "bash",
    runId: "f2170fcd-6f1c-4d80-9f25-1c72d3672d59",
    sessionId: "01a1b4f9-1aeb-7098-97c9-d37157cf4aef",
    samples: ["`npm test` 退出码 1（“3 failed”）"],
  }],
  stats: { calls: 12, writes: 0, gates: 0, windowMin: 30 },
};
const ROWS = [
  { at: base - 120_000, tool: "bash", runId: "f2170fcd", session: "01a1b4f9", ok: false, error: "boom" },
  { at: base - 60_000, tool: "read", runId: "f2170fcd", session: "01a1b4f9", ok: true, resultPreview: "ok" },
];

test("落一条事件：id 可读、issues/rows 摘要都在，能按 id 取回", () => {
  const ws = tmp();
  const out = recordDriftIncident(ws, RESULT, { now: base, rows: ROWS });
  assert.equal(out.ok, true);
  const incident = out.incident;
  assert.match(incident.id, /^drift-\d{8}T\d{6}-[0-9a-f]{6}$/);
  assert.equal(incident.at, base);
  assert.equal(incident.issues[0].runId, "f2170fcd-6f1c-4d80-9f25-1c72d3672d59");
  assert.equal(incident.rows.count, 2);
  assert.deepEqual(incident.rows.runIds, ["f2170fcd"]);
  assert.deepEqual(incident.rows.sessionIds, ["01a1b4f9"]);
  assert.equal(incident.rows.tools.bash, 1);
  assert.equal(incident.rows.recent.length, 2);
  assert.match(incident.rows.recent[0].preview, /boom/);

  // 窗口外的 rows 不进摘要（判定只看 30 分钟）
  const ws2 = tmp();
  const out2 = recordDriftIncident(ws2, RESULT, {
    now: base,
    rows: [{ at: base - 40 * 60_000, tool: "bash", ok: false }, ...ROWS],
  });
  assert.equal(out2.incident.rows.count, 2);

  assert.ok(fs.existsSync(incidentsFile(ws)));
  assert.equal(latestDriftIncident(ws).id, incident.id);
  assert.equal(getDriftIncident(ws, incident.id).id, incident.id);
  assert.equal(getDriftIncident(ws, "drift-nope"), null);
});

test("没有偏离不落事件（drift=false）", () => {
  const ws = tmp();
  const out = recordDriftIncident(ws, { drift: false, issues: [], stats: {} }, { now: base, rows: [] });
  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.equal(fs.existsSync(incidentsFile(ws)), false);
});

test("只留最近 50 条：第 1 条被挤掉，最新一条可读", () => {
  const ws = tmp();
  const ids = [];
  for (let i = 0; i < MAX_INCIDENTS + 5; i += 1) {
    const out = recordDriftIncident(ws, RESULT, { now: base + i * 1000, rows: ROWS });
    assert.equal(out.ok, true);
    ids.push(out.incident.id);
  }
  const list = listDriftIncidents(ws, 100);
  assert.equal(list.length, MAX_INCIDENTS);
  assert.equal(list[0].id, ids[ids.length - 1]);
  assert.equal(getDriftIncident(ws, ids[0]), null, "最早的 5 条应被清掉");
  assert.equal(latestDriftIncident(ws).id, ids[ids.length - 1]);
});

test("事件文件损坏时当作空处理，不抛异常", () => {
  const ws = tmp();
  fs.mkdirSync(path.dirname(incidentsFile(ws)), { recursive: true });
  fs.writeFileSync(incidentsFile(ws), "{ 坏掉的 json", "utf8");
  assert.equal(latestDriftIncident(ws), null);
  assert.deepEqual(listDriftIncidents(ws), []);
  assert.equal(getDriftIncident(ws, "drift-20261107T224354-abcdef"), null);
});
