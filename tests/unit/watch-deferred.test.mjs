// 免打扰补跑（第一条不足）：0–7 点命中只延后、不丢弃；7 点后按时间顺序补，每条一次、每天最多 3 条；
// 补跑仍过 dailyCap / cooldown / 主动预算；预算耗尽是有意放弃，不记 deferred、之后也不补。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWatchDuty, WATCH_FILE_REL } from "../../engine/watch-duty.mjs";

const silent = { log() {}, warn() {}, info() {}, error() {} };
const at = (h, m = 0, day = 7) => new Date(2026, 10, day, h, m, 0).getTime();
const BUDGET_REL = path.join("记忆", "运行时", "主动预算.json");

function tempWs() { return fs.mkdtempSync(path.join(os.tmpdir(), "watch-deferred-")); }

/** 读当天所有日志分片（日志按天切分）。 */
function readLog(ws) {
  const dir = path.join(ws, "记忆", "运行时");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => /^值班日志-\d{8}\.jsonl$/.test(n)).sort()
    .flatMap((n) => fs.readFileSync(path.join(dir, n), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

function fillBudget(ws, now, used = 1, cap = 1) {
  fs.mkdirSync(path.join(ws, "记忆", "运行时"), { recursive: true });
  const day = new Date(now).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(ws, BUDGET_REL), JSON.stringify({ cap, days: { [day]: used } }), "utf8");
}

function setup(t, { t0, wake = null } = {}) {
  const ws = tempWs();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const clock = { t: t0 };
  const calls = { wake: [], cmd: 0 };
  const duty = createWatchDuty({
    wsRoot: ws,
    probes: {
      cmd: async () => { calls.cmd += 1; return { exitCode: 0, stdout: "boom" }; },
      http: async () => ({}),
      file: async () => ({}),
    },
    wake: wake || (({ watch, hit }) => {
      calls.wake.push({ id: watch.id, reason: hit.reason, deferred: hit.deferred === true, at: hit.at });
      return { jobId: `j-${calls.wake.length}` };
    }),
    now: () => clock.t,
    log: silent,
  });
  return { ws, clock, calls, duty };
}

test("免打扰命中先记 deferred；7 点后按时间顺序补跑，每条只补一次", async (t) => {
  const { ws, clock, calls, duty } = setup(t, { t0: at(3) });
  // 冷却故意设 8 小时：05:59 那次检查会被冷却挡住，不能又攒一条新 deferred（补跑顺序才可预期）
  const a = duty.create({ name: "夜巡 A", kind: "cmd", spec: { command: "node a.mjs", expectExit: 0 }, prompt: "看看 A", intervalMs: 60_000, cooldownMs: 8 * 3600_000 });
  assert.equal(a.ok, true);

  // ① 03:00 命中：只记 deferred，不唤醒
  let r = await duty.tick({ catchUp: true });
  assert.equal(r.hits, 1);
  assert.equal(r.wakes, 0);
  assert.equal(r.suppressed, 1);
  assert.equal(calls.wake.length, 0, "免打扰不许唤醒");
  let w = duty.get(a.id);
  assert.equal(w.pendingDeferred, 1);
  assert.equal(w.runtime.deferred[0].reason, "quiet");
  assert.equal(w.runtime.deferred[0].prompt, "看看 A", "要存 prompt 快照");
  assert.ok(w.runtime.deferred[0].spec && w.runtime.deferred[0].spec.command === "node a.mjs", "要存 spec 快照");
  assert.ok(readLog(ws).some((l) => l.event === "deferred" && l.kind === "deferred" && l.action === "record"));

  // ② 03:01 再建一条并补查：A 因冷却不重复记，B 记一条 —— 两条的命中时间不同，用来验证补跑顺序
  clock.t = at(3, 1);
  const b = duty.create({ name: "夜巡 B", kind: "cmd", spec: { command: "node b.mjs", expectExit: 0 }, prompt: "看看 B", intervalMs: 60_000, cooldownMs: 8 * 3600_000 });
  r = await duty.tick({ catchUp: true });
  assert.equal(r.wakes, 0);
  assert.equal(duty.get(a.id).pendingDeferred, 1, "冷却期内不重复记 deferred");
  assert.equal(duty.get(b.id).pendingDeferred, 1);

  // ③ 05:59 还在免打扰：不补
  clock.t = at(5, 59);
  r = await duty.tick();
  assert.equal(r.deferred, 0);
  assert.equal(calls.wake.length, 0);

  // ④ 07:00 补跑：按命中时间 A 在前、B 在后
  clock.t = at(7, 0);
  r = await duty.tick();
  assert.equal(r.deferred, 2);
  assert.equal(r.wakes, 2);
  assert.deepEqual(calls.wake.map((x) => x.id), [a.id, b.id], "按命中时间升序补");
  assert.equal(calls.wake[0].deferred, true, "补跑要标记 deferred");
  assert.equal(calls.wake[0].reason, "退出码 0");
  assert.equal(duty.get(a.id).pendingDeferred, 0);
  assert.equal(duty.get(b.id).pendingDeferred, 0);
  assert.equal(duty._meta().deferredReplayed, 2);
  const replayLogs = readLog(ws).filter((l) => l.event === "deferred" && l.action === "replay");
  assert.equal(replayLogs.length, 2);
  assert.equal(replayLogs[0].kind, "deferred");

  // ⑤ 下一轮不会再补同一件事
  clock.t = at(7, 5);
  r = await duty.tick();
  assert.equal(r.deferred, 0);
  assert.equal(calls.wake.length, 2);

  // ⑥ 重启后也不会把已补的再补一遍（deferred 为空 + meta 落盘）
  const duty2 = createWatchDuty({ wsRoot: ws, probes: { cmd: async () => ({ exitCode: 0 }) }, wake: () => ({ jobId: "x" }), now: () => clock.t, log: silent });
  const r2 = await duty2.tick();
  assert.equal(r2.deferred, 0);
  assert.equal(duty2._meta().deferredReplayed, 2);
  const saved = JSON.parse(fs.readFileSync(path.join(ws, WATCH_FILE_REL), "utf8"));
  assert.equal(saved.meta.deferredReplayed, 2, "补跑计数要落盘（重启不重复补）");
});

test("免打扰命中跨重启：deferred 随状态文件活下来，7 点后照样补一次", async (t) => {
  const { ws, clock, calls, duty } = setup(t, { t0: at(3) });
  const c = duty.create({ name: "夜巡", kind: "cmd", spec: { command: "node check.mjs", expectExit: 0 }, prompt: "p", intervalMs: 60_000 });
  await duty.tick({ catchUp: true });
  assert.equal(calls.wake.length, 0);
  assert.equal(duty.get(c.id).pendingDeferred, 1);

  // 模拟服务重启：新实例从同一个 值班.json 读回
  clock.t = at(7, 5);
  const wakes = [];
  const duty2 = createWatchDuty({
    wsRoot: ws,
    probes: { cmd: async () => ({ exitCode: 1 }) }, // 重启后若重新检查也不会命中
    wake: ({ watch, hit }) => { wakes.push({ id: watch.id, deferred: hit.deferred }); return { jobId: "j2" }; },
    now: () => clock.t,
    log: silent,
  });
  assert.equal(duty2.get(c.id).pendingDeferred, 1, "重启后仍能看到待补记录");
  const r = await duty2.tick();
  assert.equal(r.deferred, 1);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].deferred, true);
});

test("预算耗尽不补：不记 deferred，过很久也不会补", async (t) => {
  const { ws, clock, calls, duty } = setup(t, { t0: at(12) });
  fillBudget(ws, clock.t, 1, 1); // 当天主动预算已用满
  const c = duty.create({ name: "白天", kind: "cmd", spec: { command: "node check.mjs", expectExit: 0 }, prompt: "p", intervalMs: 60_000, cooldownMs: 10 * 60_000 });

  let r = await duty.tick({ catchUp: true });
  assert.equal(r.hits, 1);
  assert.equal(r.wakes, 0);
  assert.equal(r.suppressed, 1);
  assert.equal(duty.get(c.id).runtime.last.suppressed, "budget");
  assert.equal(duty.get(c.id).pendingDeferred, 0, "预算耗尽是放弃，不该记 deferred");
  assert.ok(!readLog(ws).some((l) => l.event === "deferred" && l.action === "record"));

  // 同一天晚上再命中：仍然只是预算拦下，不会「补」出一次唤醒
  clock.t = at(20);
  r = await duty.tick();
  assert.equal(r.wakes, 0);
  assert.equal(r.deferred, 0);
  assert.equal(calls.wake.length, 0);
  assert.equal(duty.get(c.id).pendingDeferred, 0);
});

test("免打扰攒下的待补：7 点复跑同样过预算，预算耗尽就丢弃、不重试", async (t) => {
  const { ws, clock, calls, duty } = setup(t, { t0: at(3) });
  fillBudget(ws, clock.t, 1, 1); // 03:00 所在的 UTC 日预算已满（07:00 仍是同一 UTC 日）
  const c = duty.create({ name: "夜里", kind: "cmd", spec: { command: "node check.mjs", expectExit: 0 }, prompt: "p", intervalMs: 60_000, cooldownMs: 10 * 60_000 });
  await duty.tick({ catchUp: true });
  assert.equal(duty.get(c.id).pendingDeferred, 1, "免打扰在预算闸门之前，先记下来");

  clock.t = at(7, 0);
  let r = await duty.tick();
  assert.equal(r.deferred, 0);
  assert.equal(r.deferredDropped, 1);
  assert.equal(calls.wake.length, 0, "预算耗尽，补跑也必须放弃");
  assert.equal(duty.get(c.id).pendingDeferred, 0, "放弃后丢弃，不留在队列里反复重试");
  assert.ok(readLog(ws).some((l) => l.event === "deferred" && l.action === "skip" && l.reason === "budget"));

  clock.t = at(7, 10);
  r = await duty.tick();
  assert.equal(r.deferred, 0, "丢弃后不再补");
  assert.equal(calls.wake.length, 0);
});

test("每天最多补 3 条：第 4 条记 deferred_cap 丢弃", async (t) => {
  const { clock, calls, duty, ws } = setup(t, { t0: at(3) });
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const c = duty.create({ name: `夜巡${i}`, kind: "cmd", spec: { command: `node check${i}.mjs`, expectExit: 0 }, prompt: "p", intervalMs: 60_000 });
    assert.equal(c.ok, true);
    ids.push(c.id);
  }
  let r = await duty.tick({ catchUp: true });
  assert.equal(r.hits, 4);
  assert.equal(r.suppressed, 4);
  assert.equal(calls.wake.length, 0);

  clock.t = at(7, 0);
  r = await duty.tick();
  assert.equal(r.deferred, 3, "每天最多补 3 条");
  assert.equal(r.deferredDropped, 1);
  assert.equal(calls.wake.length, 3);
  assert.equal(duty._meta().deferredReplayed, 3);
  assert.ok(readLog(ws).some((l) => l.event === "deferred" && l.action === "skip" && l.reason === "deferred_cap"));
  for (const id of ids) assert.equal(duty.get(id).pendingDeferred, 0);
});

test("补跑同样过 dailyCap / cooldown：闸门不过就丢弃（日志写清原因）", async (t) => {
  // ① dailyCap：模拟这条 watch 当天已经唤醒过 1 次（日限=1）
  {
    const { ws, clock, calls, duty } = setup(t, { t0: at(3) });
    const c = duty.create({ name: "日限", kind: "cmd", spec: { command: "node check.mjs", expectExit: 0 }, prompt: "p", intervalMs: 60_000, dailyCap: 1 });
    await duty.tick({ catchUp: true });
    assert.equal(duty.get(c.id).pendingDeferred, 1);

    const stateFile = path.join(ws, WATCH_FILE_REL);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.watches[0].runtime.counters = { day: new Date(at(7)).toISOString().slice(0, 10), wakes: 1 };
    fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");

    clock.t = at(7, 0);
    const wakes2 = [];
    const duty2 = createWatchDuty({
      wsRoot: ws,
      probes: { cmd: async () => ({ exitCode: 0 }), http: async () => ({}), file: async () => ({}) },
      wake: ({ hit }) => { wakes2.push(hit); return { jobId: "j2" }; },
      now: () => clock.t,
      log: silent,
    });
    const r = await duty2.tick();
    assert.equal(r.deferred, 0);
    assert.equal(r.deferredDropped, 1);
    assert.equal(wakes2.length, 0, "日限已满，补跑也必须放弃");
    assert.equal(duty2.get(c.id).pendingDeferred, 0);
    assert.ok(readLog(ws).some((l) => l.event === "deferred" && l.action === "skip" && l.reason === "daily_cap"));
    assert.equal(calls.wake.length, 0);
  }

  // ② cooldown：03:00 的待补，但 06:50 刚唤醒过（冷却 30 分钟）→ 7:00 补跑被冷却挡住
  {
    const { ws, clock, duty } = setup(t, { t0: at(3) });
    const c = duty.create({ name: "冷却", kind: "cmd", spec: { command: "node check.mjs", expectExit: 0 }, prompt: "p", intervalMs: 60_000, cooldownMs: 30 * 60_000 });
    await duty.tick({ catchUp: true });

    const stateFile = path.join(ws, WATCH_FILE_REL);
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.watches[0].runtime.lastWakeAt = at(6, 50);
    state.watches[0].runtime.lastTriggerAt = at(6, 50);
    fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");

    clock.t = at(7, 0);
    const wakes2 = [];
    const duty2 = createWatchDuty({
      wsRoot: ws,
      probes: { cmd: async () => ({ exitCode: 0 }), http: async () => ({}), file: async () => ({}) },
      wake: ({ hit }) => { wakes2.push(hit); return { jobId: "j3" }; },
      now: () => clock.t,
      log: silent,
    });
    const r = await duty2.tick();
    assert.equal(r.deferred, 0);
    assert.equal(r.deferredDropped, 1);
    assert.equal(wakes2.length, 0, "冷却期内不许补跑");
    assert.ok(readLog(ws).some((l) => l.event === "deferred" && l.action === "skip" && l.reason === "cooldown"));
  }
});

test("暂停会作废待补，恢复后不会补一条旧事", async (t) => {
  const { clock, calls, duty } = setup(t, { t0: at(3) });
  const c = duty.create({ name: "夜巡", kind: "cmd", spec: { command: "node check.mjs", expectExit: 0 }, prompt: "p", intervalMs: 60_000 });
  await duty.tick({ catchUp: true });
  assert.equal(duty.get(c.id).pendingDeferred, 1);
  duty.pause(c.id);
  assert.equal(duty.get(c.id).pendingDeferred, 0);
  clock.t = at(7, 0);
  duty.resume(c.id);
  const r = await duty.tick();
  assert.equal(r.deferred, 0, "恢复后不会补旧账");
  // 恢复后第一次正常检查仍然可能命中并唤醒——那是「现在」的事，不是补跑
  assert.equal(calls.wake.length, 1);
  assert.equal(calls.wake[0].deferred, false);
});
