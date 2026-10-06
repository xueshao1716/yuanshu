// 任务中心 v2 测试：状态机 / queueId 执行身份 / 运行历史 / stop 语义 / once 自动 done / 旧格式迁移
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTimeEngine } from "../../engine/time-engine.mjs";

function tmpEngine(runner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-tasks-"));
  const file = path.join(dir, "time-tasks.json");
  const te = createTimeEngine(runner, { file });
  return { te, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('independent time engines never overwrite each other storage', t => {
  const first = tmpEngine(null), second = tmpEngine(null)
  t.after(first.cleanup); t.after(second.cleanup)
  first.te.register({ prompt: 'first' })
  second.te.register({ prompt: 'second' })
  assert.equal(JSON.parse(fs.readFileSync(first.file, 'utf8')).tasks[0].prompt, 'first')
  assert.equal(JSON.parse(fs.readFileSync(second.file, 'utf8')).tasks[0].prompt, 'second')
})

test('schedules use the same local calendar as HH:MM', t => {
  const { te, cleanup } = tmpEngine(null)
  t.after(cleanup)
  const now = new Date(2026, 9, 4, 0, 5)
  const localDay = '2026-10-04'
  const once = te.register({ type: 'once', date: localDay, at: '00:05', prompt: 'once' })
  assert.equal(te._isDue(te.find(once.id), now), true)
  const daily = te.register({ at: '00:05', prompt: 'daily' })
  te.find(daily.id).lastRun = new Date(2026, 9, 3, 20, 0).toISOString()
  assert.equal(te._isDue(te.find(daily.id), now), true, 'previous local day must not suppress today')
})

test("注册默认 active；pause/resume/archive 状态机与非法转换", async () => {
  const { te, cleanup } = tmpEngine(null);
  const r = te.register({ type: "daily", at: "09:00", prompt: "测试" });
  assert.ok(r.id);
  assert.equal(te.list()[0].state, "active");
  assert.equal(te.pause(r.id).state, "paused");
  // paused 不允许再 pause
  assert.ok(te.pause(r.id).error);
  assert.equal(te.resume(r.id).state, "active");
  assert.equal(te.archive(r.id).state, "archived");
  // archived 是终态
  assert.ok(te.resume(r.id).error);
  cleanup();
});

test("paused 任务不触发调度；runNow 手动执行记录 ok 历史 + queueId", async () => {
  let calls = 0;
  const { te, cleanup } = tmpEngine(async () => { calls++; return "任务输出内容"; });
  const r = te.register({ type: "daily", at: "23:59", prompt: "测试" });
  te.pause(r.id);
  await te.check(); // paused：不触发
  assert.equal(calls, 0);
  const rn = await te.runNow(r.id);
  assert.ok(rn.queueId, "手动执行应返回 queueId");
  assert.equal(calls, 1);
  const t = te.find(r.id);
  assert.equal(t.history.length, 1);
  assert.equal(t.history[0].status, "ok");
  assert.equal(t.history[0].queueId, rn.queueId);
  assert.match(t.history[0].result, /任务输出内容/);
  assert.equal(t.runs, 1);
  cleanup();
});

test("runner 抛错 → error 历史含原因", async () => {
  const { te, cleanup } = tmpEngine(async () => { throw new Error("网络炸了"); });
  const r = te.register({ type: "daily", at: "23:59", prompt: "x" });
  await te.runNow(r.id);
  const h = te.find(r.id).history[0];
  assert.equal(h.status, "error");
  assert.match(h.result, /网络炸了/);
  cleanup();
});

test("stop 拿到业务确认；runner 结束后该次标记 stopped", async () => {
  let resolveRun;
  let runnerSignal;
  const gate = new Promise(res => { resolveRun = res; });
  const { te, cleanup } = tmpEngine(async (_task, signal) => { runnerSignal = signal; await gate; return "晚到的结果"; });
  const r = te.register({ type: "daily", at: "23:59", prompt: "x" });
  const runP = te.runNow(r.id).catch(() => {});
  await new Promise(res => setTimeout(res, 50)); // 等 runner 进入
  const stopR = te.stopRun(r.id);
  assert.equal(stopR.stopped, false);
  assert.equal(stopR.stopping, true);
  assert.ok(stopR.queueId);
  assert.equal(runnerSignal.aborted, true, "stop 应中断实际 runner");
  assert.equal(te.list()[0].running, true, "停止确认前仍应显示运行中/停止中");
  resolveRun();
  await runP;
  const t = te.find(r.id);
  assert.ok(t.history.some(h => h.status === "stopped"), "应有 stopped 投影");
  assert.equal(te.list()[0].running, false, "runner 确认结束后才离开活动态");
  // 未在执行的任务 stop 返回未执行
  assert.equal(te.stopRun(r.id).stopped, false);
  cleanup();
});

test("once 任务执行后自动转 done；旧格式文件自动迁移补 state", async () => {
  const { te, file, cleanup } = tmpEngine(async () => "done 输出");
  // 预置旧格式（无 state/history 字段）
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: "legacy1", type: "daily", at: "09:00", prompt: "旧任务", created: new Date().toISOString(), lastRun: null, runs: 0 }] }));
  delete te._loaded; // 无缓存概念，直接重新 load
  te.start();
  te.stop();
  const legacy = te.find("legacy1");
  assert.equal(legacy.state, "active", "旧格式迁移补 active");

  const today = new Date().toISOString().slice(0, 10);
  const r = te.register({ type: "once", date: today, at: "23:58", prompt: "一次性" });
  await te.runNow(r.id);
  assert.equal(te.find(r.id).state, "done");
  cleanup();
});

test("任务成功且结果够长时触发 onTaskDone", async () => {
  let hit = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-tasks-"));
  const te = createTimeEngine(async () => "x".repeat(130), {
    file: path.join(dir, "time-tasks.json"),
    onTaskDone: (info) => { hit = info; },
  });
  const r = te.register({ type: "daily", at: "23:59", prompt: "沉淀测试任务" });
  await te.runNow(r.id);
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(hit, "成功长结果应触发沉淀钩子");
  assert.equal(hit.trigger, "time-task");
  assert.ok(hit.result.length >= 120);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("运行历史保留长结果，不被截成 200 字", async () => {
  const long = "今日反思：把未完成的事写清楚，再排明天。".repeat(40);
  assert.ok(long.length > 200);
  const { te, cleanup } = tmpEngine(async () => long);
  const r = te.register({ type: "daily", at: "23:59", prompt: "自我反思" });
  await te.runNow(r.id);
  const stored = te.find(r.id).history[0].result;
  assert.equal(stored, long);
  cleanup();
});

test("结果过短不触发 onTaskDone", async () => {
  let hit = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-tasks-"));
  const te = createTimeEngine(async () => "短", {
    file: path.join(dir, "time-tasks.json"),
    onTaskDone: (info) => { hit = info; },
  });
  const r = te.register({ type: "daily", at: "23:59", prompt: "短结果" });
  await te.runNow(r.id);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(hit, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isDue 对非 active 状态直接返回 false", () => {
  const { te, cleanup } = tmpEngine(null);
  const r = te.register({ type: "daily", at: "09:00", prompt: "x" });
  const t = te.find(r.id);
  const noon = new Date("2026-08-25T01:00:00Z"); // 本地 09:00 视时区而定，用 _isDue 内部 hm 匹配 at
  t.at = `${String(noon.getHours()).padStart(2, "0")}:${String(noon.getMinutes()).padStart(2, "0")}`;
  assert.equal(te._isDue(t, noon), true);
  te.pause(r.id);
  assert.equal(te._isDue(te.find(r.id), noon), false);
  cleanup();
});

test('missed daily/weekly slots catch up later the same day, once only', t => {
  const { te, cleanup } = tmpEngine(null)
  t.after(cleanup)
  const daily = te.find(te.register({ at: '00:00', prompt: 'reflect' }).id)
  daily.created = new Date(2026, 9, 1, 12, 0).toISOString()
  const late = new Date(2026, 9, 6, 0, 3)
  assert.equal(te._isDue(daily, late), true, 'server was down at 00:00 → run on restart')
  assert.equal(te._isDue(daily, new Date(2026, 9, 5, 23, 59)), true)
  daily.lastStart = new Date(2026, 9, 6, 0, 1).toISOString()
  assert.equal(te._isDue(daily, late), false, 'a crashed run today must not loop')
  assert.equal(te._isDue(daily, new Date(2026, 9, 7, 0, 0)), true, 'next day is due again')
  const weekly = te.find(te.register({ type: 'weekly', day: 2, at: '09:00', prompt: 'w' }).id)
  weekly.created = new Date(2026, 8, 1).toISOString()
  assert.equal(te._isDue(weekly, new Date(2026, 9, 6, 15, 0)), true, 'Tuesday afternoon catches the morning slot')
  assert.equal(te._isDue(weekly, new Date(2026, 9, 6, 8, 59)), false, 'not before the slot')
  assert.equal(te._isDue(weekly, new Date(2026, 9, 7, 15, 0)), false, 'other weekdays never catch up')
})

test('a task created after today\'s slot waits for tomorrow', t => {
  const { te, cleanup } = tmpEngine(null)
  t.after(cleanup)
  const daily = te.find(te.register({ at: '09:00', prompt: 'x' }).id)
  daily.created = new Date(2026, 9, 6, 15, 0).toISOString()
  assert.equal(te._isDue(daily, new Date(2026, 9, 6, 15, 1)), false)
  assert.equal(te._isDue(daily, new Date(2026, 9, 7, 9, 0)), true)
})

test('execute stamps lastStart before the runner finishes', async t => {
  let release
  const gate = new Promise(r => { release = r })
  const { te, file, cleanup } = tmpEngine(async () => { await gate; return 'ok' })
  t.after(cleanup)
  const id = te.register({ at: '09:00', prompt: 'x' }).id
  const pending = te.runNow(id)
  await new Promise(r => setImmediate(r))
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).tasks.find(x => x.id === id)
  assert.ok(saved.lastStart, 'lastStart persisted while running')
  assert.equal(saved.lastRun, null)
  release(); await pending
})
