// 唤醒工具集（第二条不足）：默认最小只读集、allowTools 显式白名单生效、
// system 提示「只做检查与汇报」、补跑回执标明「补跑」，以及 server 必须把 UNIFIED_TOOLS 传进来。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_WAKE_TOOLS, composeWakeMessages, createWatchWake, resolveWakeTools,
} from "../../engine/watch-wake.mjs";
import { createWatchDuty, WATCH_LOG_REL } from "../../engine/watch-duty.mjs";
import { WATCH_CREATE_TOOL } from "../../engine/tools/watch-tools.mjs";

const silent = { log() {}, warn() {}, info() {}, error() {} };
const T0 = new Date(2026, 10, 7, 12, 0, 0).getTime();

const tool = (name) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } });
const ALL_TOOLS = [
  tool("read"), tool("write"), tool("edit"), tool("bash"), tool("pwsh"),
  tool("search_files"), tool("grep"), tool("glob"), tool("web_search"), tool("read_url"),
  tool("notify_user"), tool("report"), tool("dsh_task"), tool("generate_image"),
  tool("orchestrator_read"),
];

function tempWs() { return fs.mkdtempSync(path.join(os.tmpdir(), "watch-wake-")); }
function readLog(ws) {
  const dir = path.join(ws, "记忆", "运行时");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => /^值班日志-\d{8}\.jsonl$/.test(n)).sort()
    .flatMap((n) => fs.readFileSync(path.join(dir, n), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

test("默认最小只读集：不给 write/edit/bash/pwsh/dsh_task/媒体", () => {
  assert.ok(DEFAULT_WAKE_TOOLS.includes("read"));
  assert.ok(DEFAULT_WAKE_TOOLS.includes("search_files"));
  assert.ok(DEFAULT_WAKE_TOOLS.includes("notify_user"), "回执工具要在默认集里");
  for (const bad of ["write", "edit", "bash", "pwsh", "dsh_task", "generate_image", "generate_video", "generate_tts"]) {
    assert.equal(DEFAULT_WAKE_TOOLS.includes(bad), false, `默认集不许包含 ${bad}`);
  }

  const r = resolveWakeTools(ALL_TOOLS, null);
  assert.equal(r.usingDefault, true);
  assert.deepEqual(r.names, ["read", "search_files", "grep", "glob", "web_search", "read_url", "orchestrator_read", "notify_user", "report"]);
  for (const bad of ["write", "edit", "bash", "pwsh", "dsh_task", "generate_image"]) {
    assert.equal(r.names.includes(bad), false);
  }
  // 工具表里没有的名字（不同引擎的等价工具名）静默过滤掉
  assert.equal(r.unknown.includes("orchestrator_read"), false);
  const missing = resolveWakeTools([tool("read")], ["read", "nope"]);
  assert.deepEqual(missing.unknown, ["nope"]);
});

test("allowTools 显式白名单：按它给（仍与可用工具求交集），空数组 = 一个都不给", () => {
  const r = resolveWakeTools(ALL_TOOLS, ["write", "read", "nope"]);
  assert.equal(r.usingDefault, false);
  assert.deepEqual(r.names, ["write", "read"]);
  assert.deepEqual(r.unknown, ["nope"]);

  const none = resolveWakeTools(ALL_TOOLS, []);
  assert.equal(none.usingDefault, false);
  assert.deepEqual(none.names, []);
  assert.deepEqual(none.tools, []);
});

test("watch_create schema 暴露 allowTools，并写明默认只读", () => {
  const params = WATCH_CREATE_TOOL.function.parameters;
  assert.equal(params.properties.allowTools.type, "array");
  assert.equal(params.properties.allowTools.items.type, "string");
  assert.match(params.properties.allowTools.description, /只读/);
  assert.match(WATCH_CREATE_TOOL.function.description, /allowTools/);
  assert.match(WATCH_CREATE_TOOL.function.description, /默认不给 write/);
});

test("duty.create 校验 allowTools：不填=null、显式数组原样存、坏值拒绝", (t) => {
  const ws = tempWs();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const duty = createWatchDuty({ wsRoot: ws, log: silent, now: () => T0 });
  const base = { kind: "time", spec: { type: "daily", at: "09:00" }, prompt: "p" };

  const a = duty.create({ name: "默认", ...base });
  assert.equal(a.ok, true);
  assert.equal(a.watch.allowTools, null, "不填就是默认最小集");

  const b = duty.create({ name: "白名单", ...base, allowTools: ["read", "write", "read"] });
  assert.equal(b.ok, true);
  assert.deepEqual(b.watch.allowTools, ["read", "write"], "去重、保序");

  const c = duty.create({ name: "空", ...base, allowTools: [] });
  assert.equal(c.ok, true);
  assert.deepEqual(c.watch.allowTools, [], "显式空数组要保留（= 不给工具）");

  const bad = duty.create({ name: "坏", ...base, allowTools: 123 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /allowTools/);
  const badName = duty.create({ name: "坏2", ...base, allowTools: ["has space!"] });
  assert.equal(badName.ok, false);
});

test("唤醒轮：默认只把最小只读集发给 runTurn，system 里写明只检查不改代码", async (t) => {
  const ws = tempWs();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const jobs = [];
  const jobPool = { submit(meta, run) { const j = { id: `j-${jobs.length + 1}`, ...meta, run }; jobs.push(j); return j; } };
  let captured = null;
  const wake = createWatchWake({
    wsRoot: ws,
    jobPool,
    notifier: { notify: async () => ({ ok: true }) },
    postMessage: () => ({ ok: true }),
    logFile: path.join(ws, WATCH_LOG_REL),
    allTools: ALL_TOOLS,
    runTurn: async (messages, opts) => { captured = { messages, opts }; return { text: "查过了，不用处理" }; },
    now: () => T0,
    log: silent,
  });

  const out = wake({ watch: { id: "wt-1", name: "CI", kind: "cmd", prompt: "CI 挂了就看看" }, hit: { reason: "退出码 0", detail: { stdout: "fail" } } });
  assert.equal(out.deferred, false);
  await jobs[0].run(new AbortController().signal);

  assert.deepEqual(captured.opts.tools.map((x) => x.function.name), ["read", "search_files", "grep", "glob", "web_search", "read_url", "orchestrator_read", "notify_user", "report"]);
  const system = captured.messages.find((m) => m.role === "system");
  assert.match(system.content, /只做检查与汇报/);
  assert.match(system.content, /不要改代码/);
  assert.match(system.content, /不要删数据/);
  assert.match(system.content, /allowTools/);
  const user = captured.messages.find((m) => m.role === "user");
  assert.match(user.content, /值班程序唤醒/);
  assert.match(user.content, /CI 挂了就看看/);
});

test("唤醒轮：显式 allowTools 按白名单给；空数组则以 tools:false 关闭工具", async (t) => {
  const ws = tempWs();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const jobs = [];
  const jobPool = { submit(meta, run) { const j = { id: `j-${jobs.length + 1}`, ...meta, run }; jobs.push(j); return j; } };
  const seen = [];
  const wake = createWatchWake({
    wsRoot: ws,
    jobPool,
    logFile: path.join(ws, WATCH_LOG_REL),
    allTools: ALL_TOOLS,
    // 空数组白名单会以 tools:false 下发（unifiedChat 的「无工具」语义），这里统一转成名字数组看
    runTurn: async (messages, opts) => { seen.push(opts.tools === false ? [] : opts.tools.map((x) => x.function.name)); return { text: "ok" }; },
    now: () => T0,
    log: silent,
  });

  wake({ watch: { id: "w2", name: "白名单", kind: "cmd", prompt: "p", allowTools: ["read", "write"] }, hit: { reason: "r" } });
  await jobs[0].run(new AbortController().signal);
  wake({ watch: { id: "w3", name: "空", kind: "cmd", prompt: "p", allowTools: [] }, hit: { reason: "r" } });
  await jobs[1].run(new AbortController().signal);

  assert.deepEqual(seen[0], ["read", "write"]);
  assert.deepEqual(seen[1], [], "空数组 = 这一轮没有工具");
});

test("补跑回执：标题/正文/留言板/日志都标明「补跑」", async (t) => {
  const ws = tempWs();
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const jobs = [];
  const jobPool = { submit(meta, run) { const j = { id: `j-${jobs.length + 1}`, ...meta, run }; jobs.push(j); return j; } };
  const notes = [];
  const mails = [];
  let captured = null;
  const wake = createWatchWake({
    wsRoot: ws,
    jobPool,
    notifier: { notify: async (n) => { notes.push(n); return { ok: true }; } },
    postMessage: (m) => { mails.push(m); return { ok: true }; },
    logFile: path.join(ws, WATCH_LOG_REL),
    allTools: ALL_TOOLS,
    runTurn: async (messages, opts) => { captured = { messages, opts }; return { text: "补跑结果" }; },
    now: () => T0,
    log: silent,
  });

  wake({
    watch: { id: "wt-9", name: "夜巡", kind: "cmd", prompt: "p" },
    hit: { reason: "退出码 0", deferred: true, at: T0 - 4 * 3600_000, deferredAt: T0 },
  });
  await jobs[0].run(new AbortController().signal);

  assert.match(notes[0].title, /补跑/);
  assert.match(notes[0].body, /【补跑】/);
  assert.match(mails[0].text, /【补跑】/);
  assert.equal(mails[0].meta.deferred, true);
  const user = captured.messages.find((m) => m.role === "user");
  assert.match(user.content, /补跑/);
  assert.match(user.content, /原命中时间/);
  assert.ok(readLog(ws).some((l) => l.event === "wake_dispatch" && l.deferred === true));
  assert.ok(readLog(ws).some((l) => l.event === "wake_done" && l.deferred === true));
});

test("system 消息：composeWakeMessages 第一条是 system，且带本轮工具名", () => {
  const messages = composeWakeMessages(
    { id: "w", name: "n", kind: "http", prompt: "p", allowTools: null },
    { reason: "r" },
    { now: T0, tools: [tool("read"), tool("search_files")] },
  );
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /read、search_files/);
  assert.match(messages[0].content, /只做检查与汇报/);
  assert.equal(messages[1].role, "user");
});

test("server 必须把 UNIFIED_TOOLS 作为 allTools 传给 createWatchWake（否则裁剪不生效）", () => {
  const src = fs.readFileSync(new URL("../../server.mjs", import.meta.url), "utf8");
  assert.match(src, /createWatchWake\(\{[\s\S]{0,600}?allTools:\s*UNIFIED_TOOLS/);
});
