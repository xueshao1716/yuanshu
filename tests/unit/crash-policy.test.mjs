// 未捕获异常：偶发不退出，同一签名反复出现才退出（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCrashAction, crashSignature, isFatalError, CRASH_WINDOW_MS } from "../../engine/crash-policy.mjs";

test("第一次崩溃：活下去，不退出（坏的只是那个定时器）", () => {
  const d = decideCrashAction({ history: [], now: 1_000_000 });
  assert.equal(d.action, "survive");
  assert.equal(d.repeats, 1);
});

test("同一签名 60 秒内第 3 次：退出，让 watchdog 干净重启", () => {
  const now = 1_000_000;
  const d = decideCrashAction({ history: [now - 2000, now - 1000], now });
  assert.equal(d.action, "exit");
  assert.match(d.reason, /same_crash_3x/);
});

test("分散在很久以前的次数不算（窗口外的不累计）", () => {
  const now = 10_000_000;
  const d = decideCrashAction({ history: [now - CRASH_WINDOW_MS - 5000, now - CRASH_WINDOW_MS - 9000], now });
  assert.equal(d.action, "survive");
});

test("内存耗尽直接退出", () => {
  const err = new Error("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
  assert.equal(isFatalError(err), true);
  assert.equal(decideCrashAction({ history: [], now: 1, err }).action, "exit");
});

test("签名抹掉内存地址，同一错误能稳定命中", () => {
  const a = new Error("boom"); a.stack = "Error: boom | at fn (/x.mjs:1:1) 0x7ffd1234";
  const b = new Error("boom"); b.stack = "Error: boom | at fn (/x.mjs:1:1) 0x7ffe9999";
  assert.equal(crashSignature(a), crashSignature(b));
  assert.ok(crashSignature(a).length <= 200);
});
