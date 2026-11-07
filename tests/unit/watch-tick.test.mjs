// 并发 tick（第四条不足）：同一轮内有限并发（默认 3），一条慢检查/一条报错不拖累其它 watch；
// 状态只在轮末原子落盘一次，避免并发写文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWatchDuty, clampConcurrency, mapWithConcurrency,
  DEFAULT_TICK_CONCURRENCY, MAX_TICK_CONCURRENCY,
} from "../../engine/watch-duty.mjs";

const silent = { log() {}, warn() {}, info() {}, error() {} };
const T0 = new Date(2026, 10, 7, 12, 0, 0).getTime();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempWs() { return fs.mkdtempSync(path.join(os.tmpdir(), "watch-tick-")); }

/** 造一个带「慢探针」的 duty：probes.cmd 每条延迟 delayMs，统计同时在跑的数量。 */
function slowDuty(t, { delayMs = 100, failAt = -1, tickConcurrency } = {}) {
  const ws = tempWs();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const stats = { inFlight: 0, maxInFlight: 0, calls: 0 };
  const duty = createWatchDuty({
    wsRoot: ws,
    probes: {
      cmd: async () => {
        const i = stats.calls;
        stats.calls += 1;
        stats.inFlight += 1;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        await sleep(delayMs);
        stats.inFlight -= 1;
        if (i === failAt) throw new Error(`probe ${i} 炸了`);
        return { exitCode: 1, stdout: "" }; // 不命中，不唤醒
      },
      http: async () => ({}),
      file: async () => ({}),
    },
    wake: () => ({ jobId: "j" }),
    now: () => T0,
    log: silent,
    ...(tickConcurrency ? { tickConcurrency } : {}),
  });
  return { ws, duty, stats };
}

test("tick 有限并发：6 条 100ms 检查按 3 并发跑，明显快于串行；轮末只落盘一次", async (t) => {
  const { duty, stats } = slowDuty(t, { delayMs: 100 });
  for (let i = 0; i < 6; i++) {
    const r = duty.create({ name: `盯 ${i}`, kind: "cmd", spec: { command: `node check${i}.mjs`, expectExit: 0 }, prompt: "p", intervalMs: 60_000 });
    assert.equal(r.ok, true);
  }
  const persistsBefore = duty._stats().persists;
  const started = Date.now();
  const out = await duty.tick({ catchUp: true });
  const elapsed = Date.now() - started;

  assert.equal(out.checked, 6, "6 条都要检查");
  assert.equal(out.wakes, 0);
  assert.equal(stats.calls, 6, "catchUp 每条只查一次");
  assert.equal(stats.maxInFlight, DEFAULT_TICK_CONCURRENCY, "同一轮最多 3 条同时跑");
  assert.ok(elapsed < 500, `6×100ms 串行要 600ms，并发应明显更快（实际 ${elapsed}ms）`);
  assert.equal(duty._stats().persists - persistsBefore, 1, "并发期间不写盘，轮末只写一次");
});

test("一条探针报错不拖累同轮其它 watch", async (t) => {
  const { duty, stats } = slowDuty(t, { delayMs: 30, failAt: 2 });
  for (let i = 0; i < 4; i++) {
    duty.create({ name: `盯 ${i}`, kind: "cmd", spec: { command: `node check${i}.mjs`, expectExit: 0 }, prompt: "p", intervalMs: 60_000 });
  }
  const out = await duty.tick({ catchUp: true });
  assert.equal(out.checked, 4);
  assert.equal(out.errors, 1, "坏掉的那条记 error");
  assert.equal(out.wakes, 0);
  assert.equal(stats.calls, 4, "其它三条照常跑完");
  assert.ok(duty.list().every((w) => w.runtime.lastCheckAt === T0), "每条都写到了自己的 lastCheckAt");
});

test("并发上限可配：tickConcurrency=2 时同时在跑的是 2 条", async (t) => {
  const { duty, stats } = slowDuty(t, { delayMs: 60, tickConcurrency: 2 });
  for (let i = 0; i < 4; i++) {
    duty.create({ name: `盯 ${i}`, kind: "cmd", spec: { command: `node check${i}.mjs`, expectExit: 0 }, prompt: "p", intervalMs: 60_000 });
  }
  const out = await duty.tick({ catchUp: true });
  assert.equal(out.checked, 4);
  assert.equal(stats.maxInFlight, 2);
  assert.equal(duty.summary().tickConcurrency, 2);
});

test("clampConcurrency 与 mapWithConcurrency：越界收敛、空数组直接返回", async () => {
  assert.equal(clampConcurrency(0), DEFAULT_TICK_CONCURRENCY);
  assert.equal(clampConcurrency(undefined), DEFAULT_TICK_CONCURRENCY);
  assert.equal(clampConcurrency(2), 2);
  assert.equal(clampConcurrency(99), MAX_TICK_CONCURRENCY);
  assert.equal(DEFAULT_TICK_CONCURRENCY, 3);

  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(10);
    active -= 1;
    return n * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10], "结果顺序与输入一致");
  assert.equal(peak, 2, "最多 2 条同时跑");
  assert.deepEqual(await mapWithConcurrency([], 3, async () => 1), []);
});
