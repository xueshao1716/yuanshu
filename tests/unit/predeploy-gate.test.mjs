// 部署门禁：fail-closed。2026-10-25 两次把用户正在跑的对话打掉的病根，
// 就是把「探活超时」当成了「没有活动轮次」（不知道 ≠ 安全）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDeployGate, waitForIdle, DEFAULT_MAX_WAIT_MS, MAX_CONSECUTIVE_PROBE_FAILURES } from "../../scripts/predeploy-check.mjs";

test("确认 0 个活动轮次才放行", () => {
  const v = decideDeployGate({ probeOk: true, active: 0, waitedMs: 0 });
  assert.equal(v.allow, true);
  assert.equal(v.done, true);
  assert.equal(v.code, 0);
});

test("有活动轮次：没到时限就继续等，不许放行", () => {
  const v = decideDeployGate({ probeOk: true, active: 1, waitedMs: 30_000 });
  assert.equal(v.allow, false);
  assert.equal(v.done, false, "还没到时限，应该继续轮询");
  assert.match(v.reason, /1 个活动轮次/);
});

test("等满时限仍有活动轮次：拒绝（exit 2），不是放行", () => {
  const v = decideDeployGate({ probeOk: true, active: 2, waitedMs: DEFAULT_MAX_WAIT_MS });
  assert.equal(v.allow, false);
  assert.equal(v.done, true);
  assert.equal(v.code, 2);
});

test("探不到状态：先重试，不许当安全", () => {
  const v = decideDeployGate({ probeOk: false, active: null, waitedMs: 15_000, consecutiveFailures: 1 });
  assert.equal(v.allow, false, "超时绝不能放行");
  assert.equal(v.done, false, "应该重试");
  assert.equal(v.code, 3);
});

test("连续探活失败到上限：拒绝（exit 3）——不知道就不动", () => {
  const v = decideDeployGate({ probeOk: false, active: null, waitedMs: 60_000, consecutiveFailures: MAX_CONSECUTIVE_PROBE_FAILURES });
  assert.equal(v.allow, false);
  assert.equal(v.done, true);
  assert.equal(v.code, 3);
  assert.match(v.reason, /不知道就不能动/);
});

test("waitForIdle：先超时两次、第三次拿到 0 → 放行", async () => {
  let calls = 0;
  const probe = async () => {
    calls += 1;
    if (calls < 3) throw new Error("timeout");
    return 0;
  };
  const logs = [];
  const v = await waitForIdle({ probe, maxWaitMs: 5_000, pollMs: 0, log: (m) => logs.push(m) });
  assert.equal(v.allow, true);
  assert.equal(calls, 3);
  assert.ok(logs.some((l) => /探活失败/.test(l)), "失败要有日志，别静默");
});

test("waitForIdle：一直有活动轮次 → 到时限拒绝，不重启", async () => {
  const v = await waitForIdle({ probe: async () => 1, maxWaitMs: 1, pollMs: 0, log: () => {} });
  assert.equal(v.allow, false);
  assert.equal(v.code, 2);
});
