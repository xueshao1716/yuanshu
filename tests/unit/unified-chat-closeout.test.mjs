// 2026-11-10 P0-3：流式中途出错，已推给前端的内容必须落库 + 收尾；
//              P1-2：纯聊天轮没有改动文件时，正向账本用用户原话锚定 scene。
//
// 这两条都是"收轮"边界上的事，所以走 handleUnifiedChat 真跑（mock 一个兼容 OpenAI 的流式上游），
// 不只在源码里数 if。关键断言：
//   A1 半截正文 + 一次 done（不重复）
//   A2 抛错路径 finishEmotion 仍被调用，且只调用一次（emotion 事件 = 1）
//   A3 正常收轮也只收一次（finally 没有再补一次）
//   B  纯聊天 + 用户「谢谢你」→ 正向账本真的记了一条 praise，scene 是原话摘要
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initUnifiedChat, handleUnifiedChat } from "../../engine/unified-chat.mjs";
import { initDshKeys } from "../../engine/dsh-keys.mjs";
import { initModelRouter } from "../../engine/model/router.mjs";
import { initContextLoader } from "../../engine/context-loader.mjs";
import { initYuanshuWorkmem } from "../../engine/yuanshu-workmem.mjs";
import { init as initEmotion } from "../../engine/emotion.mjs";
import { LEDGER_REL } from "../../engine/praise-ledger.mjs";

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const sseDelta = (text) => sse({ choices: [{ delta: { content: text } }] });
const sseMessage = (text) => sse({ choices: [{ message: { content: text } }] });

// mock 上游：每个测试自己决定怎么回；drain 请求体（不 drain 会让 keep-alive 连接不结束）。
async function upstream(t, respond) {
  const server = http.createServer(async (req, res) => {
    try { for await (const _ of req) { /* drain */ } } catch {}
    res.writeHead(200, { "content-type": "text/event-stream" });
    respond(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// 和 empty-fallback-handler.test.mjs 同一套最小接线：工作区全部落在临时目录，
// 不让情绪/账本/工具写到真实工作区。
function initHarness(t, root, baseUrl) {
  const model = { provider: "fixture", id: "chat-fixture", api: "openai-completions", baseUrl };
  const models = [model];
  const readJsonFile = (file) => (file === "auth"
    ? { fixture: { key: "test" } }
    : { fixture: { models } });
  initDshKeys({ authPath: "auth", modelsPath: "models", readJsonFile });
  initModelRouter({ getModelList: () => models, getDefaultModel: () => model });
  initContextLoader({ cwd: root });
  initYuanshuWorkmem(root);
  initEmotion(root);
  initUnifiedChat({
    authPath: "auth",
    modelsPath: "models",
    readJsonFile,
    getModelList: () => models,
    getDefaultModel: () => model,
    cwd: root,
    sessionDir: root,
    getAgentDir: () => root,
    UNIFIED_TOOLS: [],
    executeUnifiedTool: async () => ({ text: "ok", isError: false }),
  });
  return model;
}

function makeEntry(model, saved) {
  return {
    modelKey: model,
    sm: {
      appendMessage: (message) => saved.push(message),
      getTree: () => [],
      getSessionName: () => "closeout-test",
      appendSessionInfo: () => {},
    },
  };
}

async function runTurn({ model, entry, events, message, sessionId, writer }) {
  const w = writer || { push: (type, data) => events.push({ type, data }) };
  await handleUnifiedChat(null, entry, message, sessionId, {}, undefined, w, false, sessionId, model);
}

test("A1：流式中途报错 → 半截正文落库 + 只发一次 done", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-closeout-err-"));
  const baseUrl = await upstream(t, (res) => {
    res.write(sseDelta("前半段"));
    // 上游把正文吐到一半后报错：正文已经推给前端了
    res.write(sse({ error: { message: "upstream boom mid-stream" } }));
    res.end("data: [DONE]\n\n");
  });
  const model = initHarness(t, root, baseUrl);
  const saved = [], events = [];
  const entry = makeEntry(model, saved);

  await runTurn({ model, entry, events, message: "把这段写一半", sessionId: "closeout-error" });

  const assistant = saved.filter((m) => m.role === "assistant");
  assert.equal(assistant.length, 1, "半截正文必须落库");
  assert.match(JSON.stringify(assistant[0].content), /前半段/);

  assert.equal(events.filter((e) => e.type === "done").length, 1, "done 只能发一次");
  assert.equal(events.filter((e) => e.type === "error").length, 1, "错误仍然要报给前端");

  // 已经流过的正文不得在收尾时整段重推（否则界面会出现两遍）
  const streamed = events.filter((e) => e.type === "delta").map((e) => e.data.text).join("");
  assert.equal(streamed, "前半段");

  // 收尾只跑一次：endYuanshuEmotion 推的 emotion 事件是收尾的客观痕迹
  assert.equal(events.filter((e) => e.type === "emotion").length, 1, "finishEmotion 跑了不止一次");
});

test("A2：抛错路径 finishEmotion 仍被调用且只调用一次", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-closeout-throw-"));
  const baseUrl = await upstream(t, (res) => {
    res.write(sseDelta("BROKEN-DELTA"));
    res.end("data: [DONE]\n\n");
  });
  const model = initHarness(t, root, baseUrl);
  const saved = [], events = [];
  const entry = makeEntry(model, saved);
  // 注入：前端 writer 在推 delta 时抛错，模拟"流到一半本地异常"。
  // 异常必须原样抛给调用方（finally 不得吞掉它）。
  const writer = {
    push(type, data) {
      events.push({ type, data });
      if (type === "delta" && data?.text === "BROKEN-DELTA") throw new Error("injected_delta_failure");
    },
  };

  await assert.rejects(
    () => runTurn({ model, entry, events, message: "随便说点什么", sessionId: "closeout-throw", writer }),
    /injected_delta_failure/,
  );

  assert.equal(events.filter((e) => e.type === "emotion").length, 1,
    "抛错时 finishEmotion 必须跑，且 finally 不得再跑第二次");
});

test("A3：正常收轮 finishEmotion 也只跑一次（finally 是 no-op）", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-closeout-ok-"));
  const baseUrl = await upstream(t, (res) => {
    res.write(sseMessage("收到，这就说完了。"));
    res.end("data: [DONE]\n\n");
  });
  const model = initHarness(t, root, baseUrl);
  const saved = [], events = [];
  const entry = makeEntry(model, saved);

  await runTurn({ model, entry, events, message: "说句话", sessionId: "closeout-ok" });

  assert.equal(events.filter((e) => e.type === "done").length, 1);
  assert.equal(events.filter((e) => e.type === "emotion").length, 1,
    "正常路径上 finishEmotion 被 finally 重复调用了");
  assert.ok(saved.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("说完了")));
});

test("B：纯聊天轮 + 用户「谢谢你」→ 记一条 praise，scene 是原话摘要", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-closeout-praise-"));
  const baseUrl = await upstream(t, (res) => {
    res.write(sseMessage("不客气，能帮上就好。"));
    res.end("data: [DONE]\n\n");
  });
  const model = initHarness(t, root, baseUrl);
  const saved = [], events = [];
  const entry = makeEntry(model, saved);

  await runTurn({ model, entry, events, message: "谢谢你", sessionId: "closeout-praise" });

  const file = path.join(root, LEDGER_REL);
  assert.ok(fs.existsSync(file), "纯聊天道谢也必须记进正向账本");
  const items = JSON.parse(fs.readFileSync(file, "utf8")).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "praise");
  assert.match(items[0].scene, /谢谢你/, "scene 要回落到用户原话");
  assert.ok(String(items[0].scene).startsWith("用户原话："), `scene 应标明是原话摘要：${items[0].scene}`);
  assert.match(items[0].evidence, /用户原话/);
});
