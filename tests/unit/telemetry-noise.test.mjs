// 遥测噪音修复的回归测试（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectIncidents, exitCodeOf } from "../../engine/telemetry.mjs";

const kinds = (r) => r.incidents.map((i) => i.kind);

test("累计重启很多、但近期没有 → 不报（这是那 15 条假警报的根因）", () => {
  const r = collectIncidents({ watchdogRestarts: 85, restartRecent: 0 });
  assert.deepEqual(kinds(r), []);
});

test("近期 ≥3 次才报，且摘要分档（让同一件事命中同一条工单）", () => {
  const a = collectIncidents({ watchdogRestarts: 300, restartRecent: 4 });
  assert.deepEqual(kinds(a), ["restart"]);
  assert.match(a.incidents[0].summary, /3-9/);

  const b = collectIncidents({ watchdogRestarts: 300, restartRecent: 20 });
  assert.match(b.incidents[0].summary, /10-49/);

  const c = collectIncidents({ watchdogRestarts: 300, restartRecent: 90 });
  assert.match(c.incidents[0].summary, /50\+/);
});

test("分档后的摘要稳定：不同次数命中同一档", () => {
  const a = collectIncidents({ restartRecent: 4 }).incidents[0].summary;
  const b = collectIncidents({ restartRecent: 7 }).incidents[0].summary;
  assert.equal(a, b);
});

test("计划内退出（code=0 + update-restart）不当崩溃", () => {
  const tail = "[exit] code=0 uptime=100s pid=1 caller=at exit (file:///C:/x/engine/update-restart.mjs:19:110)";
  const r = collectIncidents({ crashTail: tail, watchdogRestarts: 0 });
  assert.deepEqual(kinds(r), []);
});

test("非 0 退出仍然要报", () => {
  const tail = "[exit] code=1 uptime=100s pid=1 caller=at exit (file:///C:/x/server.mjs:10:2)";
  const r = collectIncidents({ crashTail: tail });
  assert.deepEqual(kinds(r), ["crash"]);
});

test("exitCodeOf 解析", () => {
  assert.equal(exitCodeOf("[exit] code=0 uptime=1s"), 0);
  assert.equal(exitCodeOf("[exit] code=78 uptime=1s"), 78);
  assert.equal(exitCodeOf("没有退出行"), null);
});
