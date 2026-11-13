// 2026-11-13 重复问题回归：
//   ① 文字重复：工具调用多轮 + 长正文时，同一段正文既被"工具轨迹"落库、又被收尾正文落库。
//      真机形态（截断重试 2 次 = 3 轮工具调用）在下面的用例里复现：期望只有一条带该正文的 assistant 消息。
//   ② 图片重复：同一张图经三条投递路径 / 正文里模型自己回显 markdown 时，一条消息里只许出现一次。
//
// 走真 handleUnifiedChat（mock 兼容 OpenAI 的流式上游），不数源码里的 if。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initUnifiedChat, initToolMediaGate, createToolMediaSink, handleUnifiedChat, flushCloseoutQueue } from "../../engine/unified-chat.mjs";
import { mediaContentKey, mediaDedupeKey } from "../../engine/media/embed.mjs";
import { assistantContentWithMedia } from "../../engine/media/api.mjs";
import { initDshKeys } from "../../engine/dsh-keys.mjs";
import { initModelRouter } from "../../engine/model/router.mjs";
import { initContextLoader } from "../../engine/context-loader.mjs";
import { initYuanshuWorkmem } from "../../engine/yuanshu-workmem.mjs";
import { init as initEmotion } from "../../engine/emotion.mjs";

const SSE = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const REMOTE_IMAGE = "https://platform-outputs.agnes-ai.space/images/t2i/task_repeat/output.png";
const LOCAL_IMAGE = "/api/ws/file?path=" + encodeURIComponent("生成物/图片/同图.png");

function initHarness(root, baseUrl, executeUnifiedTool) {
  const model = { provider: "fixture", id: "chat-fixture", api: "openai-completions", baseUrl };
  const models = [model];
  const readJsonFile = (file) => (file === "auth" ? { fixture: { key: "test" } } : { fixture: { models } });
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
    wsRoot: root,
    UNIFIED_TOOLS: [{
      type: "function",
      function: { name: "make_chart", description: "干活出图", parameters: { type: "object", properties: {} } },
    }],
    executeUnifiedTool: executeUnifiedTool || (async () => ({ text: "ok", isError: false })),
  });
  return model;
}

// 每一轮上游怎么回，由调用方给；drain 请求体（不 drain 会让 keep-alive 连接不结束）。
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

function makeEntry(saved) {
  return {
    sm: {
      sessionFile: "",
      appendMessage: (message) => saved.push(message),
      getTree: () => [],
      getSessionName: () => "repeat-test",
      appendSessionInfo: () => {},
    },
  };
}

async function runTurn({ entry, events, sessionId, message = "做个东西" }) {
  const writer = { push: (type, data) => events.push({ type, data }) };
  try {
    await handleUnifiedChat(null, entry, message, sessionId, {}, undefined, writer, false, sessionId);
  } finally {
    await flushCloseoutQueue();
  }
}

const textOf = (m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
const assistantBodies = (saved) => saved.filter((m) => m?.role === "assistant" && textOf(m).trim());

test("① 工具调用 3 轮 + 长正文：同一段正文只落库一次（截断重试形态）", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-repeat-text-"));
  let request = 0;
  const baseUrl = await upstream(t, (res) => {
    request += 1;
    const n = Math.min(request, 2);
    const longText = `第${n}轮的长正文：` + "这是一段够长的中间分析，用来复现工具多轮时的重复。".repeat(6);
    res.write(SSE({
      choices: [{
        delta: {
          content: longText,
          tool_calls: [{ index: 0, id: `call-${request}`, type: "function", function: { name: "make_chart", arguments: "{}" } }],
        },
        finish_reason: "length",   // 半截输出 → 走截断接续重试，第 3 轮返回 TRUNCATED_TOOL_ERROR
      }],
    }));
    res.end("data: [DONE]\n\n");
  });
  initHarness(root, baseUrl);
  const saved = [];
  const events = [];
  await runTurn({ entry: makeEntry(saved), events, sessionId: "repeat-text" });

  const dup = assistantBodies(saved).filter((m) => textOf(m).includes("第2轮的长正文"));
  assert.equal(dup.length, 1, `同一段正文只许落一条 assistant，实际 ${dup.length} 条：${JSON.stringify(dup.map((m) => JSON.stringify(m.content).slice(0, 120)))}`);
  assert.equal(events.filter((e) => e.type === "done").length, 1, "一轮只发一次 done");
});

test("①b 流式中途上游报错：半截正文只落一条、只推一次", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-repeat-err-"));
  const baseUrl = await upstream(t, (res) => {
    res.write(SSE({ choices: [{ delta: { content: "半截正文，已经很完整了，写到一半上游断流。" } }] }));
    res.write(SSE({ error: { message: "upstream cut" } }));
    res.end();
  });
  initHarness(root, baseUrl);
  const saved = [];
  const events = [];
  await runTurn({ entry: makeEntry(saved), events, sessionId: "repeat-err" });

  const bodies = assistantBodies(saved);
  assert.equal(bodies.length, 1, "错误分支只许落一条正文");
  assert.ok(textOf(bodies[0]).includes("半截正文"));
  assert.equal(events.filter((e) => e.type === "delta" && String(e.data?.text || "").includes("半截正文")).length, 1, "同一段正文不许整段重推第二次");
});

test("② 同一张图经三条路径：内容级去重只收一条", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-repeat-img-"));
  const dir = path.join(root, "生成物", "图片");
  fs.mkdirSync(dir, { recursive: true });
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(9000, 0x41)]);
  const paths = ["同图-a.png", "同图-b.png", "同图-c.png"].map((name) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    return "/api/ws/file?path=" + encodeURIComponent(`生成物/图片/${name}`);
  });
  // 内容键：同一份字节的三个落地文件必须是同一个键
  const keys = paths.map((u) => mediaContentKey(u, { wsRoot: root }));
  assert.equal(new Set(keys).size, 1, `同一张图内容键必须一致，实际 ${JSON.stringify(keys)}`);
  assert.notEqual(mediaContentKey(paths[0], { wsRoot: root }), mediaContentKey("/api/ws/file?path=" + encodeURIComponent("生成物/图片/别的.png"), { wsRoot: root }));

  // 三条投递路径共用同一个 sink：只收第一条、只进一次落库清单
  const sink = createToolMediaSink({ wsRoot: root });
  const accepted = paths.map((url) => sink.accept({ type: "image", url }));
  assert.deepEqual(accepted, [true, false, false], "同一内容只许收一次");
  assert.equal(sink.items.length, 1);

  // 跨路径：媒体意图早跑那条已经发过同一张图（内容键），工具直传这条不许再发
  const delivered = new Set([mediaDedupeKey(paths[0], { wsRoot: root })]);
  const crossSink = createToolMediaSink({
    wsRoot: root,
    isDelivered: (url) => delivered.has(mediaDedupeKey(url, { wsRoot: root })),
    markDelivered: (url) => delivered.add(mediaDedupeKey(url, { wsRoot: root })),
  });
  assert.equal(crossSink.accept({ type: "image", url: paths[1] }), false, "早跑路径发过的同一张图，工具直传不再发");
  assert.equal(crossSink.items.length, 0);
});

test("②c 真跑一轮出图：正文回显 + 工具直传同一条 → 只推一次 media、只落一次图", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-repeat-img-e2e-"));
  let request = 0;
  const baseUrl = await upstream(t, (res) => {
    request += 1;
    if (request === 1) {
      res.write(SSE({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-chart", type: "function", function: { name: "make_chart", arguments: "{}" } }] } }] }));
    } else {
      res.write(SSE({ choices: [{ delta: { content: `画好了，图在下面。\n\n![图片](${LOCAL_IMAGE})\n\n就是这张。` } }] }));
    }
    res.end("data: [DONE]\n\n");
  });
  initHarness(root, baseUrl, async () => ({ text: "图好了", isError: false, media: { type: "image", url: REMOTE_IMAGE } }));
  initToolMediaGate({ timeoutMs: 3000, saveArtifact: async () => ({ url: LOCAL_IMAGE, local: true, reason: "" }) });

  const saved = [];
  const events = [];
  await runTurn({ entry: makeEntry(saved), events, sessionId: "repeat-img-e2e", message: "画个你" });

  const mediaEvents = events.filter((e) => e.type === "media");
  assert.equal(mediaEvents.length, 1, `同一张图只许推一次 media，实际 ${mediaEvents.length} 次`);
  const finalBody = assistantBodies(saved).map((m) => decodeURIComponent(JSON.stringify(m.content))).join("\n");
  const marks = finalBody.split("同图.png").length - 1;
  assert.equal(marks, 1, `落库的那条消息里同一张图只许出现一次，实际 ${marks} 次：${finalBody.slice(0, 400)}`);
});

test("②b 正文已回显同一张图时，不再追加第二个图片块", () => {
  const text = `画好了，图在下面。\n\n![图片](${LOCAL_IMAGE})\n\n这就是成图。`;
  const blocks = assistantContentWithMedia(text, [
    { type: "image", url: LOCAL_IMAGE, model: "agnes/x" },
    { type: "image", url: LOCAL_IMAGE, model: "agnes/x" },
  ]);
  const body = decodeURIComponent(JSON.stringify(blocks));
  const marks = body.split("同图.png").length - 1;
  assert.equal(marks, 1, `同一张图在一条消息里只许出现一次，实际 ${marks} 次：${body}`);
});
