// 值班程序端到端（假执行器）：创建 → 未命中零唤醒 → 命中一次 → 冷却/预算不足不推送 → 重启补跑一次。
// 再加：活跃上限、暂停、命令红线不执行、time 到点只唤醒一次，以及 HTTP/工具接口的接线冒烟。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWatchDuty, WATCH_FILE_REL, WATCH_LOG_REL, MAX_ACTIVE_WATCHES,
} from "../../engine/watch-duty.mjs";
import { createWatchWake } from "../../engine/watch-wake.mjs";

const silent = { log() {}, warn() {}, info() {}, error() {} };
const T0 = new Date(2026, 10, 7, 12, 0, 0).getTime(); // 本地中午：避开 0–7 点免打扰
const BUDGET_REL = path.join("记忆", "运行时", "主动预算.json");

function tempWs() { return fs.mkdtempSync(path.join(os.tmpdir(), "watch-duty-")); }

/** 假执行器：probes 全部可替换、wake 只计数（不碰模型、不碰 job-pool）。 */
function setup(t, { t0 = T0 } = {}) {
  const ws = tempWs();
  t?.after?.(() => fs.rmSync(ws, { recursive: true, force: true }));
  const clock = { t: t0 };
  const calls = { cmd: 0, http: 0, file: 0, wake: [] };
  const obs = {
    cmd: () => ({ exitCode: 1, stdout: "", stderr: "" }),
    http: () => ({ status: 500, body: "" }),
    file: () => ({ exists: false }),
  };
  const duty = createWatchDuty({
    wsRoot: ws,
    probes: {
      cmd: async () => { calls.cmd += 1; return obs.cmd(); },
      http: async () => { calls.http += 1; return obs.http(); },
      file: async () => { calls.file += 1; return obs.file(); },
    },
    wake: ({ watch, hit }) => { calls.wake.push({ id: watch.id, reason: hit.reason }); return { jobId: `j-${calls.wake.length}` }; },
    now: () => clock.t,
    log: silent,
  });
  return { ws, clock, calls, obs, duty };
}

const readLog = (ws) => fs.readFileSync(path.join(ws, WATCH_LOG_REL), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("端到端：创建 → 未命中零唤醒 → 命中一次 → 预算不足不推送 → 重启恢复补跑一次", async (t) => {
  const { ws, clock, calls, obs, duty } = setup(t);
  const created = duty.create({
    name: "CI 挂了", kind: "cmd",
    spec: { command: "node scripts/ci-check.mjs", expectExit: 0 },
    prompt: "看看 CI 为什么挂，能修就修",
    intervalMs: 60_000, cooldownMs: 600_000, dailyCap: 5,
  });
  assert.equal(created.ok, true);
  assert.equal(created.watch.state, "active");
  assert.equal(created.watch.intervalMs, 60_000);

  // ① 未命中：连查 3 次，一次唤醒都没有（这就是"不烧模型"）
  for (let i = 0; i < 3; i++) {
    clock.t += 60_000;
    const r = await duty.tick();
    assert.equal(r.checked, 1);
    assert.equal(r.hits, 0);
  }
  assert.equal(calls.cmd, 3);
  assert.equal(calls.wake.length, 0, "未命中绝不允许唤醒（零模型调用）");

  // ② 命中一次 → 唤醒一次
  obs.cmd = () => ({ exitCode: 0, stdout: "CI failed: 3 tests", stderr: "" });
  clock.t += 60_000;
  let r = await duty.tick();
  assert.equal(r.hits, 1);
  assert.equal(r.wakes, 1);
  assert.equal(calls.wake.length, 1);
  assert.match(calls.wake[0].reason, /退出码 0/);

  // ③ 冷却中再命中：只记日志，不重复唤醒
  clock.t += 60_000;
  r = await duty.tick();
  assert.equal(r.hits, 1);
  assert.equal(r.suppressed, 1);
  assert.equal(calls.wake.length, 1, "冷却期内不重复唤醒");
  assert.equal(duty.list()[0].runtime.last.suppressed, "cooldown");

  // ④ 预算不够：把当天主动预算用满，过了冷却也不推送，只落一条 suppressed=budget 的日志
  const day = new Date(clock.t).toISOString().slice(0, 10);
  fs.mkdirSync(path.join(ws, "记忆", "运行时"), { recursive: true });
  fs.writeFileSync(path.join(ws, BUDGET_REL), JSON.stringify({ cap: 1, days: { [day]: 1 } }), "utf8");
  clock.t += 10 * 60_000;
  r = await duty.tick();
  assert.equal(r.hits, 1);
  assert.equal(r.wakes, 0);
  assert.equal(calls.wake.length, 1, "预算不够不许唤醒/推送");
  assert.ok(readLog(ws).some((l) => l.event === "suppressed" && l.reason === "budget"), "预算不够要留日志");
  assert.equal(duty.list()[0].runtime.last.suppressed, "budget");

  // 预算被拦之后也要按冷却节流，不能每个检查周期都重记一次
  clock.t += 60_000;
  r = await duty.tick();
  assert.equal(r.wakes, 0);
  assert.equal(r.suppressed, 1);
  assert.equal(duty.list()[0].runtime.last.suppressed, "cooldown");

  // ⑤ 重启恢复：换一个实例从同一个状态文件读回；错过很多个间隔也只补查一次
  fs.writeFileSync(path.join(ws, BUDGET_REL), JSON.stringify({ cap: 1, days: {} }), "utf8");
  clock.t += 3 * 3600_000;
  const calls2 = { cmd: 0 };
  const wake2 = [];
  const duty2 = createWatchDuty({
    wsRoot: ws,
    probes: { cmd: async () => { calls2.cmd += 1; return { exitCode: 0, stdout: "still failing" }; }, http: async () => ({}), file: async () => ({}) },
    wake: ({ hit }) => { wake2.push(hit.reason); return { jobId: `j2-${wake2.length}` }; },
    now: () => clock.t,
    log: silent,
  });
  assert.equal(duty2.list().length, 1, "重启后要能读回值班");
  assert.equal(duty2.list()[0].id, created.id);
  const r2 = await duty2.tick({ catchUp: true });
  assert.equal(r2.checked, 1);
  assert.equal(calls2.cmd, 1, "重启后每条最多补查一次（不按错过次数雪崩）");
  assert.equal(wake2.length, 1, "补查命中要能唤醒");
  await duty2.tick();
  assert.equal(calls2.cmd, 1, "补查完按间隔计时，不能连环补");

  const saved = JSON.parse(fs.readFileSync(path.join(ws, WATCH_FILE_REL), "utf8"));
  assert.equal(saved.watches.length, 1);
  assert.equal(saved.watches[0].id, created.id);
  assert.equal(saved.watches[0].runtime.wakeCount, 2, "唤醒次数要落盘（重启不丢）");
  assert.ok(readLog(ws).some((l) => l.event === "wake" && l.jobId === "j-1"));
});

test("活跃上限：同时最多 10 条，第 11 条被拒并说明原因", async (t) => {
  const { duty } = setup(t);
  for (let i = 0; i < MAX_ACTIVE_WATCHES; i++) {
    const r = duty.create({ name: `盯 ${i}`, kind: "time", spec: { type: "daily", at: "09:00" }, prompt: "p" });
    assert.equal(r.ok, true, `第 ${i + 1} 条应该能建`);
  }
  const over = duty.create({ name: "第 11 条", kind: "time", spec: { type: "daily", at: "09:00" }, prompt: "p" });
  assert.equal(over.ok, false);
  assert.match(over.error, /最多 10 条/);
});

test("暂停后不再检查；恢复后继续", async (t) => {
  const { duty, calls } = setup(t);
  const c = duty.create({ name: "盯文件", kind: "file", spec: { path: "日志.txt", mode: "changed" }, prompt: "p" });
  assert.equal(duty.pause(c.id).ok, true);
  await duty.tick({ catchUp: true });
  assert.equal(calls.file, 0, "暂停的值班不该被检查");
  assert.equal(duty.resume(c.id).ok, true);
  await duty.tick({ catchUp: true });
  assert.equal(calls.file, 1);
});

test("cmd 红线：宪法 deny 优先，被拒的命令不执行、不唤醒", async (t) => {
  const ws = tempWs();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  let wakes = 0;
  const duty = createWatchDuty({
    wsRoot: ws,
    wake: () => { wakes += 1; return { jobId: "j" }; },
    now: () => T0,
    log: silent,
  });
  duty.create({ name: "危险命令", kind: "cmd", spec: { command: "git push --force origin main" }, prompt: "p" });
  const r = await duty.tick({ catchUp: true });
  assert.equal(r.hits, 0);
  assert.equal(wakes, 0);
  const w = duty.list()[0];
  assert.match(w.runtime.last.reason, /红线|no-force-git/);
  assert.ok(readLog(ws).some((l) => l.event === "blocked"), "被策略拒绝要留证据");
});

test("time：到点唤醒一次，同一天不再重复", async (t) => {
  const { duty, clock, calls } = setup(t, { t0: new Date(2026, 10, 7, 8, 0, 0).getTime() });
  duty.create({ name: "早报", kind: "time", spec: { type: "daily", at: "09:00" }, prompt: "p" });
  await duty.tick({ catchUp: true }); // 08:00 还没到点
  assert.equal(calls.wake.length, 0);
  clock.t = new Date(2026, 10, 7, 9, 0, 0).getTime();
  let r = await duty.tick();
  assert.equal(r.hits, 1);
  assert.equal(calls.wake.length, 1);
  clock.t += 60_000;
  r = await duty.tick();
  assert.equal(r.hits, 0, "同一个点只触发一次");
  assert.equal(calls.wake.length, 1);
});

test("唤醒执行链：交 job-pool → 跑模型轮 → 推送 + 留言板回执 + 值班日志", async (t) => {
  const ws = tempWs();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const submitted = [];
  const jobPool = {
    submit(meta, run) {
      const job = { id: `j-${submitted.length + 1}`, ...meta, run };
      submitted.push(job);
      return job;
    },
  };
  const notes = [];
  const mails = [];
  const wake = createWatchWake({
    wsRoot: ws,
    jobPool,
    notifier: { notify: async (n) => { notes.push(n); return { ok: true }; } },
    postMessage: (m) => { mails.push(m); return { ok: true }; },
    logFile: path.join(ws, WATCH_LOG_REL),
    runTurn: async (messages) => {
      assert.match(messages[0].content, /值班程序唤醒/);
      assert.match(messages[0].content, /CI 偶发失败/);
      return { text: "已核对：CI 是偶发失败，不用处理" };
    },
    now: () => T0,
    log: silent,
  });

  const out = wake({ watch: { id: "wt-1", name: "CI", kind: "cmd", prompt: "CI 偶发失败就看看" }, hit: { reason: "退出码 0", detail: { stdout: "fail" } } });
  assert.equal(out.jobId, "j-1");
  assert.equal(submitted.length, 1);
  await submitted[0].run(new AbortController().signal);

  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /值班「CI」/);
  assert.match(notes[0].body, /偶发失败/);
  assert.equal(notes[0].toWechat, true);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].kind, "alert");
  assert.equal(mails[0].to, "小语");
  assert.match(mails[0].text, /退出码 0/);
  assert.ok(readLog(ws).some((l) => l.event === "wake_done" && l.jobId === "j-1"));
});

test("结构性保证：watch-duty 不 import 任何模型/对话模块，也不用 eval", () => {
  const src = fs.readFileSync(new URL("../../engine/watch-duty.mjs", import.meta.url), "utf8");
  const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
  for (const bad of ["unified-chat", "model/", "notifier", "job-pool", "direct-chat"]) {
    assert.ok(!importLines.includes(bad), `值班判定层不许 import ${bad}`);
  }
  assert.ok(!/new Function\s*\(|node:vm/.test(src), "不许跑任意 JS");
});

test("接口接线：四条 HTTP 路由与四个工具执行器都走同一个 duty", async (t) => {
  const { createWatchRoutes } = await import("../../engine/watch-api.mjs");
  const { createWatchToolExecutors } = await import("../../engine/tools/watch-tools.mjs");
  const { duty } = setup(t);

  const routes = createWatchRoutes({
    duty: () => duty,
    json: (res, code, obj) => res.out.push({ code, obj }),
    readBody: async () => ({ name: "接口建的", kind: "time", spec: { type: "daily", at: "09:00" }, prompt: "p" }),
  });
  assert.equal(routes.length, 4);
  const res = { out: [] };

  routes.find(([m, p]) => m === "GET" && p === "/api/watches")[2](res);
  assert.equal(res.out.at(-1).code, 200);
  assert.equal(res.out.at(-1).obj.ok, true);

  await routes.find(([m, p]) => m === "POST" && p === "/api/watches")[2](res, {});
  const created = res.out.at(-1);
  assert.equal(created.code, 200);
  const id = created.obj.id;

  const pause = routes.find(([m, p]) => typeof p !== "string" && p.test(`/api/watches/${id}/pause`))[2];
  await pause(res, {}, null, [null, id]);
  assert.equal(res.out.at(-1).obj.state, "paused");
  assert.equal(duty.list()[0].state, "paused");

  const del = routes.find(([m]) => m === "DELETE")[2];
  del(res, {}, null, [null, id]);
  assert.equal(res.out.at(-1).obj.removed, true);
  assert.equal(duty.list().length, 0);

  const execs = createWatchToolExecutors({ getDuty: () => duty });
  const createdByTool = execs.watch_create({ name: "工具建的", kind: "time", spec: { type: "daily", at: "09:00" }, prompt: "p" });
  assert.equal(createdByTool.isError, false);
  assert.match(createdByTool.text, /已建值班/);
  assert.match(execs.watch_list().text, /工具建的/);
  const toolId = duty.list()[0].id;
  assert.equal(execs.watch_pause({ id: toolId, paused: true }).isError, false);
  assert.equal(execs.watch_delete({ id: toolId }).isError, false);
  assert.equal(duty.list().length, 0);
});
