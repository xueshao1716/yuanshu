// dsh 对话适配器：主驾一轮真实对话，不是 unifiedChat 套皮
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDshPrompt, finishDshText, runDshTurn, handleDshChat } from "../../engine/dsh-chat.mjs";
import { sdkSafeAssistantBlocks } from "../../engine/yuanshu-session.mjs";
import { init as initEmotion } from "../../engine/emotion.mjs";

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

// 2026-11-10 P1-6：dsh 臂接上"最小一致面"——落库 sdkSafe + usage 事件 + 情绪/关系收尾。
// 其余四层（基因/成长/反模式/复习/正向账本）明确不接，理由是 dsh 没有工具事件/交付回执，
// 证据来源不成立；源码里的说明注释由下面的契约断言守住，别悄悄删掉改成"接上了"。
test("P1-6：dsh 一轮后 关系.json interactions +1、落库块是 sdkSafe 形式、有 usage 事件", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-closeout-"));
  initEmotion(root);
  const events = [];
  const appended = [];
  let capturedTask = "";
  const entry = {
    sm: {
      sessionFile: "",
      appendMessage: (m) => appended.push(m),
      getSessionName: () => "t",
      appendSessionInfo: () => {},
    },
  };
  await handleDshChat(null, entry, "帮我把这句话改顺一点", "sid-dsh-p16", undefined, {
    writer: { push: (e, d) => events.push({ e, d }) },
    history: [{ role: "user", text: "之前聊过" }],
    runTurn: async ({ task }) => { capturedTask = task; return { ok: true, text: "改好了，读起来更顺。" }; },
  });

  // ① 落库块与主通道同一形态：sdkSafeAssistantBlocks 的输出，不是裸字符串
  const assistant = appended.find((m) => m.role === "assistant");
  assert.ok(assistant, "必须落一条 assistant");
  assert.deepEqual(assistant.content, sdkSafeAssistantBlocks([{ type: "text", text: "改好了，读起来更顺。" }]));
  assert.ok(Array.isArray(assistant.content) && assistant.content.every((b) => typeof b?.type === "string"));

  // ② usage 事件必须在（没有实测值 → 0/0，但要标 estimated，别让界面当"0 成本"）
  const usage = events.find((x) => x.e === "usage");
  assert.ok(usage, "dsh 也要推 usage 事件");
  assert.equal(usage.d.estimated, true);
  assert.equal(usage.d.prompt, 0);
  assert.equal(usage.d.completion, 0);

  // ③ 情绪开轮注入进了 prompt，收尾推了 emotion 事件
  assert.match(capturedTask, /本轮语境/, "情绪语境必须真的进 dsh 的 prompt");
  assert.ok(events.some((x) => x.e === "emotion" && x.d?.state), "收尾要推 emotion 事件");
  // usage/emotion 必须在 done 之前（done 之后前端就不再跑了）
  const doneAt = events.findIndex((x) => x.e === "done");
  for (const name of ["usage", "emotion"]) {
    const at = events.findIndex((x) => x.e === name);
    assert.ok(at >= 0 && at < doneAt, `${name} 事件必须在 done 之前`);
  }

  // ④ 关系.json interactions +1（judgeTurnKind 判 neutral，只计次数）
  const rel = JSON.parse(readFileSync(join(root, "记忆", "运行时", "关系.json"), "utf8"));
  assert.equal(rel.interactions, 1, "dsh 一轮必须记一次互动");
  assert.match(String(rel.lastAt || ""), /^\d{4}-\d{2}-\d{2}T/);
});

test("P1-6：不接的层在源码里写明理由（不许悄悄接半套）", () => {
  const src = readFileSync(join(ROOT, "engine", "dsh-chat.mjs"), "utf8");
  // 纯文本正文时 sdkSafeAssistantBlocks 的输出与裸块相同，运行时断言区分不出"有没有走它"，
  // 所以这条守源码契约：dsh 的落库块必须来自 sdkSafeAssistantBlocks。
  assert.match(src, /sdkSafeAssistantBlocks\(/, "落库必须走 sdkSafeAssistantBlocks（防重放崩）");
  assert.match(src, /基因 \/ 成长/, "要写明基因/成长不接");
  assert.match(src, /反模式/, "要写明反模式不接");
  assert.match(src, /复习/, "要写明复习不接");
  assert.match(src, /正向账本/, "要写明正向账本不接");
  assert.ok(!src.includes("advanceGenomeTurn"), "dsh 不能硬接基因层");
  assert.ok(!src.includes("advanceGrowthTurn"), "dsh 不能硬接成长层");
  assert.ok(!src.includes("recordFromTurn"), "dsh 不能硬接正向账本");
});
