// dsh 对话适配器：主驾一轮真实对话，不是 unifiedChat 套皮
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDshPrompt, finishDshText, runDshTurn, handleDshChat } from "../../engine/dsh-chat.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("buildDshPrompt 带最近对话和本轮用户，不套派单 JSON 协议", () => {
  const p = buildDshPrompt(
    [{ role: "user", text: "昨天的问题" }, { role: "assistant", text: "昨天的答复" }],
    "今天继续",
  );
  assert.match(p, /昨天的问题/);
  assert.match(p, /昨天的答复/);
  assert.match(p, /今天继续/);
  assert.match(p, /小语/);
  assert.ok(!p.includes("\"result\""), "对话主驾不要套 dsh_task 结构化协议");
});

test("finishDshText：有协议则取 result，否则原文", () => {
  assert.equal(finishDshText('前言\n{"result":"结论","steps":["a"]}'), "结论");
  assert.equal(finishDshText("就是这句话"), "就是这句话");
});

test("runDshTurn 收集 stdout；已 abort 不 spawn", async () => {
  let spawned = 0;
  const ac = new AbortController();
  ac.abort();
  const r = await runDshTurn({
    task: "hi",
    bin: "fake.js",
    spawnFn: () => { spawned++; throw new Error("should not spawn"); },
    signal: ac.signal,
  });
  assert.equal(spawned, 0);
  assert.equal(r.aborted, true);
  assert.equal(r.ok, false);
});

test("runDshTurn abort 会 kill 子进程", async () => {
  let killed = false;
  const ac = new AbortController();
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; queueMicrotask(() => child.emit("close", 1)); };
    return child;
  };
  const p = runDshTurn({ task: "hi", bin: "fake.js", spawnFn, signal: ac.signal, timeoutMs: 8000 });
  ac.abort();
  const r = await p;
  assert.equal(killed, true);
  assert.equal(r.aborted, true);
});

test("runDshTurn 正常结束回 stdout", async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("你好世界"));
      child.emit("close", 0);
    });
    return child;
  };
  const r = await runDshTurn({ task: "hi", bin: "fake.js", spawnFn });
  assert.equal(r.ok, true);
  assert.equal(r.text, "你好世界");
});

test("handleDshChat 写入会话并推 delta/done", async () => {
  const events = [];
  const appended = [];
  const entry = {
    sm: {
      sessionFile: "",
      appendMessage: (m) => appended.push(m),
      getSessionName: () => "t",
      appendSessionInfo: () => {},
    },
  };
  await handleDshChat(null, entry, "你好", "sid-1", undefined, {
    writer: { push: (e, d) => events.push({ e, d }) },
    history: [{ role: "user", text: "之前" }],
    runTurn: async () => ({ ok: true, text: "dsh 答：在" }),
  });
  assert.equal(appended[0].role, "user");
  assert.equal(appended[1].role, "assistant");
  assert.match(String(appended[1].content?.[0]?.text || ""), /dsh 答/);
  assert.ok(events.some((x) => x.e === "delta" && String(x.d?.text || "").includes("dsh 答")));
  assert.ok(events.some((x) => x.e === "done" && x.d?.sessionId === "sid-1"));
});

test("handleChat 主驾 dsh 必须走 handleDshChat", () => {
  const src = readFileSync(join(ROOT, "server.mjs"), "utf8");
  const start = src.indexOf("async function handleChat");
  const fn = src.slice(start, start + 20000);
  assert.ok(fn.includes("handleDshChat"), "dsh 主驾不能掉进 unifiedChat");
  assert.ok(fn.includes('lead === "dsh"') || fn.includes("lead === 'dsh'"));
});
