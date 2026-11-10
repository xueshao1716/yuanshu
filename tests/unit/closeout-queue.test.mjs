// 2026-11-10 P1：收轮从"请求生命周期内同步写完"改成"响应结束后异步串行队列"。
//
// 这一组只测收尾队列本身，不跑完整对话：
//   A 串行/FIFO：同一时刻只跑一个任务；
//   B 抛错隔离：第一个任务抛错，第二个照跑；
//   C 静默：enqueueCloseout 返回的 promise 不 reject（失败只记 console）；
//   D 只写变化项：内容一字未变的 atomicWriteJson 不再落盘（注入 fs 桩计数）；
//   E 开关：注入 sync 配置走同步路径，async 走队列（不改环境变量）；
//   F 接线：finishEmotion 投队列、YUANSHU_CLOSEOUT 启动读一次、收尾耗时落 jsonl。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  enqueueCloseout,
  flushCloseoutQueue,
  dispatchCloseout,
  setCloseoutMode,
  getCloseoutMode,
} from "../../engine/unified-chat.mjs";
import { atomicWriteJson, jsonWriteStats } from "../../engine/atomic-io.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-closeout-queue-"));
}

async function waitUntil(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("等待条件超时（队列没有按预期启动？）");
}

test("A 队列串行：FIFO，同一时刻只跑一个", async (t) => {
  const events = [];
  let running = 0;
  let maxRunning = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(async () => { release(); await flushCloseoutQueue(); });

  const first = enqueueCloseout(async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    events.push("a:start");
    await gate;
    events.push("a:end");
    running -= 1;
  });
  const second = enqueueCloseout(() => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    events.push("b:start");
    events.push("b:end");
    running -= 1;
  });

  await waitUntil(() => events.length === 1);
  assert.deepEqual(events, ["a:start"], "第一个任务没放行时，第二个就不能开始");
  release();
  await Promise.all([first, second]);
  await flushCloseoutQueue();

  assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end"], "必须是 FIFO 串行");
  assert.equal(maxRunning, 1, "同一时刻只能跑一个收尾任务");
});

test("B 抛错隔离：第一个任务抛错，第二个仍然执行", async () => {
  const events = [];
  const first = enqueueCloseout(() => {
    events.push("bad");
    throw new Error("boom");
  });
  const second = enqueueCloseout(() => { events.push("good"); });

  await Promise.all([first, second]);
  await flushCloseoutQueue();

  assert.deepEqual(events, ["bad", "good"]);
});

test("C 静默：队列任务抛错不冒泡（返回的 promise resolve）", async () => {
  const pending = enqueueCloseout(() => { throw new Error("silent-failure"); });
  await assert.doesNotReject(() => pending, "收尾任务失败只该记 console，不能 reject");
  await flushCloseoutQueue();
});

test("D 只写变化项：内容没变时 atomicWriteJson 不再落盘（注入 fs 桩）", () => {
  const file = path.join(tmpRoot(), "记忆", "运行时", "关系.json");
  const rel = {
    trust: 0.25,
    intimacy: 0.25,
    interactions: 32,
    notes: [],
    firstSeen: "2026-11-09T12:41:23.300Z",
    lastAt: "2026-11-10T13:41:49.978Z",
  };
  const calls = { write: 0, rename: 0 };
  // 注入/桩：只统计写与 rename；读/建目录仍走真 fs（去重必须先读得到旧内容）。
  const fsStub = {
    mkdirSync: (...args) => fs.mkdirSync(...args),
    writeFileSync: (...args) => { calls.write += 1; return fs.writeFileSync(...args); },
    renameSync: (...args) => { calls.rename += 1; return fs.renameSync(...args); },
    unlinkSync: (...args) => fs.unlinkSync(...args),
    statSync: (...args) => fs.statSync(...args),
    readFileSync: (...args) => fs.readFileSync(...args),
  };
  const before = jsonWriteStats();

  assert.equal(atomicWriteJson(file, rel, fsStub), true, "第一次（文件不存在）必须写");
  assert.equal(calls.write, 1);
  assert.equal(calls.rename, 1);
  assert.equal(jsonWriteStats().writes - before.writes, 1);

  // 关系快照一字未变 → 跳过 write + rename，只计一次 skipped
  assert.equal(atomicWriteJson(file, rel, fsStub), false, "内容没变时必须跳过落盘");
  assert.equal(calls.write, 1, "跳过的空写不能再碰 writeFileSync");
  assert.equal(calls.rename, 1, "跳过的空写不能再 rename");
  assert.equal(jsonWriteStats().writes - before.writes, 1);
  assert.equal(jsonWriteStats().skipped - before.skipped, 1);

  // 真变了（interactions +1）→ 照写：去重不能把状态吞掉
  assert.equal(atomicWriteJson(file, { ...rel, interactions: 33 }, fsStub), true);
  assert.equal(calls.write, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).interactions, 33);
});

test("E 开关：注入 sync 走同步路径，async 走队列（不改环境变量）", async () => {
  const original = getCloseoutMode();
  try {
    setCloseoutMode("sync");
    assert.equal(getCloseoutMode(), "sync");
    let ran = false;
    const syncRun = dispatchCloseout(() => { ran = true; });
    assert.equal(ran, true, "sync 模式必须当场执行（旧行为）");
    await syncRun;

    setCloseoutMode("async");
    let ranAsync = false;
    const queuedRun = dispatchCloseout(() => { ranAsync = true; });
    assert.equal(ranAsync, false, "async 模式不得当场执行");
    await queuedRun;
    assert.equal(ranAsync, true);
    assert.equal(getCloseoutMode(), "async");
  } finally {
    setCloseoutMode(original);
    await flushCloseoutQueue();
  }
});

test("F 接线：finishEmotion 投队列、环境变量启动读一次、收尾耗时落 jsonl", () => {
  const src = fs.readFileSync(path.join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  assert.match(src, /const finishEmotion = \(\) => \{/);
  assert.match(src, /if \(emotionFinished\) return;/, "一次性语义必须保留");
  assert.match(src, /dispatchCloseout\(runCloseout\)/, "收尾必须交给 dispatchCloseout");
  assert.match(src, /env\("CLOSEOUT"\)/, "开关要从统一 env 入口读（兼容旧名）");
  assert.match(src, /收尾耗时\.jsonl/, "观测要落 记忆/运行时/收尾耗时.jsonl");
  assert.match(src, /\[closeout\]/, "每轮要打一行 [closeout] 日志");
});
