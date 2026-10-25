// 崩溃报告的"验收标准"：字段齐不齐、能不能定位、版本还支持吗
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCrashReport, missingFields, diagnosability, frameCount,
  versionSupported, triageLine, REQUIRED_FIELDS, MIN_SUPPORTED_VERSION,
} from "../../engine/crash-report-spec.mjs";

const goodStack = [
  "uncaughtException: Error: boom",
  "    at Timeout._onTimeout (file:///app/server.mjs:2314:28)",
  "    at listOnTimeout (node:internal/timers:594:17)",
  "    at process.processTimers (node:internal/timers:535:7)",
].join("\n");

test("字段齐全 + 够长的栈 = addressable", () => {
  const r = buildCrashReport({
    version: "2.129.3", commit: "f7be534c6", platform: "linux", arch: "x64",
    node: "v22.11.0", uptimeSec: 2242, signature: "Error: boom|at Timeout", stack: goodStack, exitCode: 1,
  });
  assert.deepEqual(missingFields(r), []);
  assert.equal(frameCount(r.stack), 3);
  assert.equal(diagnosability(r).level, "addressable");
  assert.match(triageLine(r), /\[addressable\]/);
});

test("只有一行栈（我们真机收到的那种）= unusable 或 partial，不能算 addressable", () => {
  const r = buildCrashReport({
    version: "2.129.3", commit: "f7be534c6", platform: "linux", arch: "x64", node: "v22.11.0",
    uptimeSec: 3, signature: "x", stack: "server.mjs:2314:28 <- at listOnTimeout", exitCode: 1,
  });
  const d = diagnosability(r);
  assert.notEqual(d.level, "addressable");
  assert.equal(d.frames, 0);
});

test("缺 commit = partial（行号会漂移，没构建锚就不能直接开工）", () => {
  const r = buildCrashReport({ version: "2.129.3", platform: "linux", arch: "x64", node: "v22", uptimeSec: 10, signature: "s", stack: goodStack, exitCode: 1 });
  const d = diagnosability(r);
  assert.equal(d.level, "partial");
  assert.ok(d.missing.includes("commit"));
});

test("exitCode 允许 null（被强杀/未捕获异常不算缺字段）", () => {
  const r = buildCrashReport({ version: "2.129.3", commit: "abc", platform: "linux", arch: "x64", node: "v22", uptimeSec: 1, signature: "s", stack: goodStack, exitCode: null });
  assert.deepEqual(missingFields(r), []);
});

test("老版本报告会被标出来（低于支持窗口）", () => {
  assert.equal(versionSupported("2.127.73"), false);
  assert.equal(versionSupported(MIN_SUPPORTED_VERSION), true);
  assert.equal(versionSupported("2.129.3"), true);
  const old = buildCrashReport({ version: "2.127.73", commit: "x", platform: "linux", arch: "x64", node: "v22", uptimeSec: 5, signature: "s", stack: goodStack, exitCode: 1 });
  assert.match(triageLine(old), /低于支持窗口/);
});

test("必填字段清单本身是稳定的（改动要同步文档）", () => {
  assert.deepEqual(REQUIRED_FIELDS, ["version", "commit", "platform", "arch", "node", "uptimeSec", "kind", "signature", "stack", "exitCode"]);
});
