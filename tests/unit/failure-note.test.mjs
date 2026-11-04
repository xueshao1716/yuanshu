// 失败要说人话：503/402/网络/超时各说各的（2026-11-04）
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFailure } from "../../engine/failure-note.mjs";

test("503 → 说明是服务不可用，不是用户问题", () => {
  const t = describeFailure("HTTP 503 Service Unavailable");
  assert.match(t, /503/);
  assert.match(t, /不是你的问题/);
});

test("带重试次数时说清试了几个通道", () => {
  const t = describeFailure({ message: "HTTP 503" }, { tried: 3 });
  assert.match(t, /试了 3 个通道/);
});

test("402 余额 / 401 鉴权 / 429 限流各说各的", () => {
  assert.match(describeFailure("HTTP 402"), /余额不足/);
  assert.match(describeFailure("HTTP 401"), /鉴权失败/);
  assert.match(describeFailure("HTTP 429"), /限流|额度/);
});

test("网络与超时", () => {
  assert.match(describeFailure("fetch failed"), /网络/);
  assert.match(describeFailure("ETIMEDOUT"), /网络/);
  assert.match(describeFailure("执行超时"), /超时/);
});

test("交付门 RED 时说明活干完了但没过门", () => {
  const t = describeFailure("deliver RED：2 次命令执行失败");
  assert.match(t, /交付门没过/);
});

test("空原因也给一句，不装成功", () => {
  assert.match(describeFailure(""), /没做成/);
  assert.match(describeFailure(null), /没做成/);
});

test("未知错误保留原文（截断）", () => {
  const t = describeFailure("some weird internal state xyz");
  assert.match(t, /some weird internal/);
});
