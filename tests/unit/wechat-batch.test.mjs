// 连续消息合并：debounce / 合并内容 / 最长等待 / 分人（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatcher } from "../../engine/wechat-batch.mjs";

function fakeTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id },
    clearTimer: (id) => timers.delete(id),
    fire(id) { const t = timers.get(id); timers.delete(id); t?.fn() },
    fireAll() { for (const [id] of [...timers]) this.fire(id) },
    count: () => timers.size,
    pendingWaits: () => [...timers.values()].map((t) => t.ms),
  };
}

test("1200ms 内连发三条 → 合成一条", () => {
  const tm = fakeTimers();
  const flushed = [];
  let clock = 0;
  const b = createBatcher({ onFlush: (k, merged) => flushed.push({ k, merged }), setTimer: tm.setTimer, clearTimer: tm.clearTimer, now: () => clock });

  b.push("u1", { text: "在吗", contextToken: "t1" });
  clock += 300;
  b.push("u1", { text: "帮我看看", contextToken: "t2" });
  clock += 300;
  b.push("u1", { text: "就是那个报错", contextToken: "t3" });

  assert.equal(flushed.length, 0, "还没到点，不该 flush");
  tm.fireAll();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].merged.text, "在吗\n帮我看看\n就是那个报错");
  assert.equal(flushed[0].merged.contextToken, "t3", "用最新一条的 token");
  assert.equal(flushed[0].merged.mergedCount, 3);
});

test("不同人各成一桶", () => {
  const tm = fakeTimers();
  const flushed = [];
  const b = createBatcher({ onFlush: (k, m) => flushed.push([k, m.text]), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  b.push("u1", { text: "a" });
  b.push("u2", { text: "b" });
  tm.fireAll();
  assert.equal(flushed.length, 2);
  assert.deepEqual(flushed.map((x) => x[0]).sort(), ["u1", "u2"]);
});

test("话痨一直发也不会无限拖：超过 maxWait 就按上限 flush", () => {
  const tm = fakeTimers();
  const flushed = [];
  let clock = 0;
  const b = createBatcher({ delayMs: 1200, maxWaitMs: 3000, onFlush: (_k, m) => flushed.push(m.text), setTimer: tm.setTimer, clearTimer: tm.clearTimer, now: () => clock });
  b.push("u1", { text: "1" });
  clock += 1500; b.push("u1", { text: "2" });
  clock += 1500; b.push("u1", { text: "3" });
  // 最后一次的等待应是 0（已到上限）
  const waits = [...tm.pendingWaits()];
  assert.equal(waits[waits.length - 1], 0);
  tm.fireAll();
  assert.equal(flushed.length, 1);
});

test("单独一条也会 flush（不能因为只有一条就不处理）", () => {
  const tm = fakeTimers();
  const flushed = [];
  const b = createBatcher({ onFlush: (_k, m) => flushed.push(m.text), setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  b.push("u1", { text: "就一句" });
  tm.fireAll();
  assert.deepEqual(flushed, ["就一句"]);
});
