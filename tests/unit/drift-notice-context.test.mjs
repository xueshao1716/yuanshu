// 看门狗通知正文（2026-11-07）：要回答「哪一轮 / 哪个工具 / 失败成什么样 / 去哪看」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeDriftNotice } from "../../engine/drift-escalation.mjs";
import { detectDrift } from "../../engine/watchdog-drift.mjs";

// 用本地时间构造，避免测试机时区不同导致 HH:mm 断言漂移。
const at = (h, m, s = 0) => new Date(2026, 10, 7, h, m, s).getTime();

const ISSUE = {
  code: "failing",
  detail: "bash 连续失败 3 次",
  n: 3,
  tool: "bash",
  runId: "f2170fcd-6f1c-4d80-9f25-1c72d3672d59",
  sessionId: "01a1b4f9-1aeb-7098-97c9-d37157cf4aef",
  taskId: "",
  runIds: [
    "f2170fcd-6f1c-4d80-9f25-1c72d3672d59",
    "4f535005-8336-4212-92d2-a9fd6390f17f",
  ],
  firstAt: at(22, 29, 13),
  lastAt: at(22, 33, 51),
  startedAt: at(22, 31, 45),
  samples: ["`npm test` 退出码 1（“3 failed”）"],
  evidence: "run:f2170fcd-6f1c-4d80-9f25-1c72d3672d59",
};

test("四要素齐全：任务/会话、工具、失败样子、可查链接", () => {
  const incidentId = "drift-20261107-224354-a1b2c3";
  const text = composeDriftNotice([ISSUE], { incidentId });
  assert.match(text, /看门狗/);
  assert.match(text, /跑偏/);
  // ① 哪个任务/会话（短 id + 开始时间 + 另有几轮）
  assert.match(text, /run f2170fcd/);
  assert.match(text, /22:31 开始/);
  assert.match(text, /另有 1 轮/);
  // ② 哪个工具（detail 自带）
  assert.match(text, /bash 连续失败 3 次/);
  // ③ 失败成了什么样
  assert.match(text, /npm test/);
  assert.match(text, /退出码 1/);
  assert.match(text, /3 failed/);
  // ④ 去哪里看，且 id 与接口一致
  assert.match(text, new RegExp(`/api/watchdog/drift/${incidentId}`));
  // 两个明确出口
  assert.match(text, /继续/);
  assert.match(text, /停/);
  assert.ok(text.length < 600, "IM 一屏内");
});

test("没有 id：明说只能看时间，不装作知道", () => {
  const text = composeDriftNotice([{
    code: "failing",
    detail: "bash 连续失败 3 次",
    tool: "bash",
    firstAt: at(22, 29, 13),
    lastAt: at(22, 33, 51),
    samples: [],
  }]);
  assert.match(text, /没带 id，只能看时间/);
  assert.match(text, /22:29–22:33/);
  assert.match(text, /没留到失败输出/);
  assert.match(text, /\/api\/watchdog\/drift\/latest/);
  assert.doesNotMatch(text, /run [0-9a-f]{8}/);
});

test("多条问题时 limit 生效，且不会把未选中的问题写进正文", () => {
  const text = composeDriftNotice([ISSUE, { ...ISSUE, detail: "write 同参数重复 6 次", code: "loop" }], { limit: 1 });
  assert.match(text, /bash 连续失败 3 次/);
  assert.doesNotMatch(text, /同参数重复/);
});

test("detail 没带工具名时（只改不验）补上工具，四要素仍齐", () => {
  const text = composeDriftNotice([{
    code: "no_gate",
    detail: "改了 6 次却没过一次交付门",
    tool: "write",
    runId: "f2170fcd-6f1c-4d80-9f25-1c72d3672d59",
    startedAt: at(22, 12),
    samples: ["`frontend/src/App.tsx`"],
  }]);
  assert.match(text, /· write · 改了 6 次却没过一次交付门/);
  assert.match(text, /frontend\/src\/App\.tsx/);
});

test("detectDrift → composeDriftNotice 串起来：字段名对得上", () => {
  const rows = [
    { tool: "bash", at: at(22, 31, 45), argsHash: "h1", ok: false, runId: "f2170fcd-6f1c-4d80-9f25-1c72d3672d59", session: "01a1b4f9-1aeb-7098-97c9-d37157cf4aef", argsPreview: JSON.stringify({ command: "npm test" }), error: "3 failed\n[退出码 1]" },
    { tool: "bash", at: at(22, 33, 51), argsHash: "h2", ok: false, runId: "f2170fcd-6f1c-4d80-9f25-1c72d3672d59", session: "01a1b4f9-1aeb-7098-97c9-d37157cf4aef", argsPreview: JSON.stringify({ command: "npm test" }), error: "3 failed\n[退出码 1]" },
    { tool: "bash", at: at(22, 34, 10), argsHash: "h3", ok: false, runId: "f2170fcd-6f1c-4d80-9f25-1c72d3672d59", session: "01a1b4f9-1aeb-7098-97c9-d37157cf4aef", argsPreview: JSON.stringify({ command: "npm test" }), error: "3 failed\n[退出码 1]" },
  ];
  const res = detectDrift(rows, { now: at(22, 43) });
  const text = composeDriftNotice(res.issues, { incidentId: "drift-20261107T224354-abc123" });
  assert.match(text, /run f2170fcd/);
  assert.match(text, /22:31 开始/);
  assert.match(text, /bash 连续失败 3 次/);
  assert.match(text, /npm test/);
  assert.match(text, /退出码 1/);
  assert.match(text, /\/api\/watchdog\/drift\/drift-20261107T224354-abc123/);
});
