// watchdog_read 工具（2026-11-07）：用户追问「刚才哪件事跑偏了」时，输出能直接转述的中文。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordDriftIncident } from "../../engine/watchdog-incidents.mjs";
import {
  WATCHDOG_READ_TOOL, createWatchdogReadExecutors, formatIncidentForModel,
} from "../../engine/tools/watchdog-read.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ys-wd-read-"));
const at = (h, m, s = 0) => new Date(2026, 10, 7, h, m, s).getTime();

const RESULT = {
  drift: true,
  issues: [{
    code: "failing",
    detail: "bash 连续失败 3 次",
    n: 3,
    tool: "bash",
    runId: "f2170fcd-6f1c-4d80-9f25-1c72d3672d59",
    sessionId: "01a1b4f9-1aeb-7098-97c9-d37157cf4aef",
    runIds: ["f2170fcd-6f1c-4d80-9f25-1c72d3672d59", "4f535005-8336-4212-92d2-a9fd6390f17f"],
    firstAt: at(22, 29, 13),
    lastAt: at(22, 33, 51),
    startedAt: at(22, 31, 45),
    samples: ["`npm test` 退出码 1（“3 failed”）"],
    evidence: "run:f2170fcd-6f1c-4d80-9f25-1c72d3672d59",
  }],
  stats: { calls: 12, writes: 0, gates: 0, windowMin: 30 },
};

test("工具 schema：名字/参数正确，只读不需要必填", () => {
  assert.equal(WATCHDOG_READ_TOOL.function.name, "watchdog_read");
  assert.equal(WATCHDOG_READ_TOOL.function.parameters.properties.id.type, "string");
  assert.equal(WATCHDOG_READ_TOOL.function.parameters.required, undefined);
});

test("没有事件：自然语言说明，不是 JSON、不报错", () => {
  const ws = tmp();
  const out = createWatchdogReadExecutors({ wsRoot: ws }).watchdog_read();
  assert.equal(out.isError, false);
  assert.match(out.text, /没有看门狗跑偏事件/);
  assert.doesNotMatch(out.text, /^\s*[{[]/);
});

test("最近一条：输出是自然语言，含哪一轮/工具/失败样子/事件 id", () => {
  const ws = tmp();
  const incident = recordDriftIncident(ws, RESULT, { now: at(22, 43, 54), rows: [] }).incident;
  const out = createWatchdogReadExecutors({ wsRoot: ws }).watchdog_read();
  assert.equal(out.isError, false);
  assert.match(out.text, /22:31 开始的那一轮/);
  assert.match(out.text, /run f2170fcd/);
  assert.match(out.text, /bash 连续失败 3 次/);
  assert.match(out.text, /npm test/);
  assert.match(out.text, /退出码 1/);
  assert.match(out.text, new RegExp(incident.id));
  assert.match(out.text, new RegExp(`/api/watchdog/drift/${incident.id}`));
  assert.doesNotMatch(out.text, /^\s*[{[]/, "不能只回裸 JSON");
  assert.doesNotMatch(out.text, /"issues"\s*:/, "不能把事件 JSON 塞给模型");
});

test("指定 id：能取回同一条；id 不存在时给出下一步", () => {
  const ws = tmp();
  const incident = recordDriftIncident(ws, RESULT, { now: at(22, 43, 54), rows: [] }).incident;
  const exec = createWatchdogReadExecutors({ wsRoot: ws });
  const hit = exec.watchdog_read({ id: incident.id });
  assert.equal(hit.isError, false);
  assert.match(hit.text, new RegExp(incident.id));

  const miss = exec.watchdog_read({ id: "drift-20260101T000000-abcdef" });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /没找到/);
  assert.match(miss.text, /不填 id/);
  assert.doesNotMatch(miss.text, /^\s*[{[]/);
});

test("formatIncidentForModel：没 id 时如实说只能按时间对", () => {
  const text = formatIncidentForModel({
    id: "drift-20261107T224354-abcdef",
    at: at(22, 43, 54),
    issues: [{
      code: "failing",
      detail: "bash 连续失败 3 次",
      firstAt: at(22, 29, 13),
      lastAt: at(22, 33, 51),
      samples: [],
    }],
  });
  assert.match(text, /这轮没带 id，只能按时间对/);
  assert.match(text, /22:29–22:33/);
  assert.match(text, /事件 id：drift-20261107T224354-abcdef/);
  assert.match(text, /没有停任务/);
});
