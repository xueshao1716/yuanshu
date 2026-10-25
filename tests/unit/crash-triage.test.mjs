// 报告能不能对上号 + 对不上时说清为什么（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import { triageReport, projectFrames, looksLikeOurBuild } from "../../engine/crash-triage.mjs";

const stackReal = [
  "uncaughtException: Error: EACCES",
  "    at Object.openSync (node:fs:565:3)",
  "    at writeJson (file:///home/lf/pi-workspace/yuanshu/engine/store.mjs:42:7)",
  "    at Timeout._onTimeout (file:///home/lf/pi-workspace/yuanshu/server.mjs:2314:28)",
].join("\n");

test("单行栈 + 无构建号 = no_build，并要对方补 crash.log", () => {
  const r = triageReport({ item: { title: "[自动上报] crash: boom", detail: "server.mjs:2314:28 <- at listOnTimeout" } });
  assert.equal(r.matchable, false);
  assert.equal(r.kind, "no_build");
  assert.match(r.reply, /没对上号/);
  assert.match(r.reply, /crash\.log/);
});

test("老版本 = stale，明确请对方升级，而不是拿旧栈假定位", () => {
  const r = triageReport({ item: { env: { version: "2.127.73", commit: "abc1234", platform: "linux" }, detail: stackReal } });
  assert.equal(r.matchable, false);
  assert.equal(r.kind, "stale");
  assert.match(r.reply, /假定位|对不上/);
});

test("路径不属于本仓库构建 = foreign", () => {
  const frames = projectFrames(stackReal);
  assert.ok(frames.some((f) => f.loc.includes("server.mjs")));
  // 正式安装路径里就带 Yuanshu，必须认作「我们的构建」（大小写不敏感）
  assert.equal(looksLikeOurBuild({ loc: "file:///C:/Program Files/Yuanshu/app/server.mjs" }), true);
  assert.equal(looksLikeOurBuild({ loc: "file:///opt/other/app/server.mjs" }), false);
  const r = triageReport({ item: { env: { version: "2.129.4", commit: "f7be534c6", platform: "linux" }, detail: "uncaughtException: x\n    at a (file:///opt/other/app/server.mjs:1:1)\n    at b (file:///opt/other/app/x.js:2:2)\n    at c (file:///opt/other/app/y.js:3:3)" } });
  assert.equal(r.kind, "foreign");
  assert.match(r.reply, /正式构建|源码/);
});

test("字段齐全 + 能对上构建 = 可开工，回复是「能定位」", () => {
  const r = triageReport({
    item: { kind: "crash", env: { version: "2.129.4", commit: "f7be534c6", platform: "win32", arch: "x64", node: "v22", uptimeSec: 30, signature: "s", exitCode: 1 }, detail: "uncaughtException: x\n    at a (C:\\Users\\x\\Yuanshu\\app\\server.mjs:1:1)\n    at b (C:\\Users\\x\\Yuanshu\\app\\s.mjs:2:2)\n    at c (C:\\Users\\x\\Yuanshu\\app\\t.mjs:3:3)" },
    self: { platform: "win32", version: "2.129.4", commit: "f7be534c6" },
  });
  assert.equal(r.matchable, true);
  assert.match(r.reply, /对上了|能定位/);
});

test("平台不同会写进原因（不是本机的锅也要说清）", () => {
  const r = triageReport({
    item: { env: { version: "2.129.4", commit: "f7be534c6", platform: "linux" }, detail: stackReal },
    self: { platform: "win32" },
  });
  assert.ok(r.reasons.some((x) => /linux/.test(x)));
});

test("回复里永远不假装已在修（对不上时不给空头承诺）", () => {
  for (const item of [{ detail: "x" }, { env: { version: "2.100.0", commit: "abc1234" }, detail: "y" }]) {
    const r = triageReport({ item });
    assert.equal(r.matchable, false);
    assert.doesNotMatch(r.reply, /我已经找到|已经修复/);
  }
});

test("修好后的第二封回信：没有版本或没写改了什么，就拒发（不空喊修好了）", async () => {
  const { resolutionReply } = await import("../../engine/crash-triage.mjs");
  assert.equal(resolutionReply({ item: { title: "crash: x" }, fix: { version: "" , change: "修了" } }).ok, false);
  assert.equal(resolutionReply({ item: {}, fix: { version: "2.130.0", change: "" } }).ok, false);

  const ok = resolutionReply({
    item: { title: "[自动上报] crash: [exit] code=1 uptime=3s" },
    fix: { version: "2.130.0", commit: "abc1234def", change: "定时器异常不再拖垮进程", verify: "升级后连续跑 30 分钟不重启" },
  });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /v2\.130\.0/);
  assert.match(ok.text, /定时器异常/);
  assert.match(ok.text, /连续跑 30 分钟/);
  assert.doesNotMatch(ok.text, /自动上报/);
});
