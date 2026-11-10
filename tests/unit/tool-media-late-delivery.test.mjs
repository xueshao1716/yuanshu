// 2026-11-10 P1-4：工具直传的媒体原来是 fire-and-forget，下载晚于 done 就"既不显示也不落库"。
//
// 证据：unified-chat 的 deliverGatedToolMedia 以前是 `void (async () => …)()`；前端
// ChatArea 在 streamRef 已清空时直接 return（finalize 已置 null）。gateIncomingMedia 对
// 远端图片必须下载，慢一点就整条丢掉。
//
// 修法验收（真跑 handleUnifiedChat，不数源码里的 if）：
//   A 下载慢 100ms → 收尾等它落定；落库的 assistant 块里带上这张图（本地地址）
//   B 下载一直不返回 → 按"未落盘"路径留一行 note；整轮照常 done，不失败、不卡死
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initUnifiedChat,
  initToolMediaGate,
  createToolMediaSink,
  handleUnifiedChat,
  flushCloseoutQueue,
} from "../../engine/unified-chat.mjs";
import { initDshKeys } from "../../engine/dsh-keys.mjs";
import { initModelRouter } from "../../engine/model/router.mjs";
import { initContextLoader } from "../../engine/context-loader.mjs";
import { initYuanshuWorkmem } from "../../engine/yuanshu-workmem.mjs";
import { init as initEmotion } from "../../engine/emotion.mjs";

const SSE = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const REMOTE_IMAGE = "https://platform-outputs.agnes-ai.space/images/t2i/task_late/output.png";
const LOCAL_IMAGE = "/api/ws/file?path=" + encodeURIComponent("生成物/图片/直传图.png");

// 和 unified-chat-closeout.test.mjs 同一套最小接线：工作区全部落在临时目录。
function initHarness(root, baseUrl) {
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
    UNIFIED_TOOLS: [{
      type: "function",
      function: { name: "make_chart", description: "出一张图", parameters: { type: "object", properties: {} } },
    }],
    executeUnifiedTool: async () => ({ text: "图好了", isError: false, media: { type: "image", url: REMOTE_IMAGE } }),
  });
  return model;
}

// 上游：第一轮发 tool_call → 执行工具（工具回 media）→ 第二轮正文收口。
async function upstream(t, replyText = "图已经出好了。") {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    try { for await (const _ of req) { /* drain */ } } catch {}
    requests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (requests === 1) {
      res.write(SSE({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-chart", type: "function", function: { name: "make_chart", arguments: "{}" } }] } }] }));
    } else {
      res.write(SSE({ choices: [{ delta: { content: replyText } }] }));
    }
    res.end("data: [DONE]\n\n");
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
      getSessionName: () => "late-media-test",
      appendSessionInfo: () => {},
    },
  };
}

async function runTurn({ entry, events, sessionId }) {
  const writer = { push: (type, data) => events.push({ type, data }) };
  try {
    await handleUnifiedChat(null, entry, "出一张图", sessionId, {}, undefined, writer, false, sessionId);
  } finally {
    await flushCloseoutQueue();
  }
}

test("P1-4：只有图片进落库清单，视频/音频保持原行为（闸门是同步的，没有晚到问题）", () => {
  const sink = createToolMediaSink();
  assert.equal(sink.accept({ type: "image", url: "/api/ws/file?path=a.png" }), true);
  assert.equal(sink.accept({ type: "image", url: "/api/ws/file?path=a.png" }), false, "同一张图去重");
  assert.equal(sink.items.length, 1);
  assert.equal(sink.accept({ type: "video", url: "/api/ws/file?path=b.mp4" }), true, "视频仍要直播");
  assert.equal(sink.accept({ type: "audio", url: "/api/ws/file?path=c.mp3" }), true);
  assert.equal(sink.items.length, 1, "视频/音频不进落库清单");
});

test("P1-4 A：下载慢 100ms，收尾等它落定 → 落库的 assistant 块里带上这张图", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-late-media-slow-"));
  const baseUrl = await upstream(t);
  initHarness(root, baseUrl);
  // 模拟"下载比 done 慢"：100ms 后才返回本地地址
  initToolMediaGate({
    timeoutMs: 3000,
    saveArtifact: async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { url: LOCAL_IMAGE, local: true, reason: "" };
    },
  });

  const saved = [];
  const events = [];
  const entry = makeEntry(saved);
  await runTurn({ entry, events, sessionId: "late-media-slow" });

  // 会话里会先落一条工具调用轨迹（role=assistant + toolCall 块），正文是最后那条
  const assistant = saved.filter((m) => m.role === "assistant" && !JSON.stringify(m.content).includes("toolCall"));
  assert.equal(assistant.length, 1, "收尾必须落一条正文 assistant");
  const body = JSON.stringify(assistant[0].content);
  assert.ok(body.includes("![图片]"), `落库块要带图片 markdown：${body}`);
  assert.ok(decodeURIComponent(body).includes("直传图.png"), `落库块要是本地地址：${body}`);
  assert.ok(!body.includes("platform-outputs.agnes-ai.space"), "落库绝不能留厂商临时地址");

  // 图确实推给了前端（media 事件），且 done 在最后（先本地化 → 再落库 → 再 done）
  assert.ok(events.some((e) => e.type === "media" && decodeURIComponent(String(e.data?.url || "")).includes("直传图.png")));
  assert.equal(events.filter((e) => e.type === "done").length, 1);
  const doneAt = events.findIndex((e) => e.type === "done");
  const mediaAt = events.findIndex((e) => e.type === "media");
  assert.ok(mediaAt >= 0 && mediaAt < doneAt, "图必须在 done 之前送达，晚到就丢");
});

test("P1-4 B：下载一直不返回 → 超时走 note 路径，整轮照常 done（不失败、不卡死）", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-late-media-timeout-"));
  const baseUrl = await upstream(t);
  initHarness(root, baseUrl);
  // 可注入短超时：不返回的下载 50ms 就被判超时（生产是 10s）
  initToolMediaGate({
    timeoutMs: 50,
    saveArtifact: () => new Promise(() => { /* 永远不 resolve：模拟"下载卡住" */ }),
  });

  const saved = [];
  const events = [];
  const entry = makeEntry(saved);
  const startedAt = Date.now();
  await runTurn({ entry, events, sessionId: "late-media-timeout" });
  assert.ok(Date.now() - startedAt < 5000, "超时必须由闸门兜底，不能把整轮拖住");

  // 仍是成功的一轮：有正文 assistant 落库、有 done，没有 error
  const assistant = saved.filter((m) => m.role === "assistant" && !JSON.stringify(m.content).includes("toolCall"));
  assert.equal(assistant.length, 1, "图片超时不能让整轮失败");
  const body = JSON.stringify(assistant[0].content);
  assert.ok(!body.includes("直传图.png"), `超时的图不能落库：${body}`);
  assert.equal(events.filter((e) => e.type === "done").length, 1);
  assert.equal(events.filter((e) => e.type === "error").length, 0, "超时不能报错");

  // 走的是现有"未落盘"路径：一行 note
  const note = events.find((e) => e.type === "note" && /没能存到本地|没能及时存到本地/.test(String(e.data?.text || "")));
  assert.ok(note, `超时后要留一行说明：${JSON.stringify(events.filter((e) => e.type === "note").map((e) => e.data?.text))}`);
  assert.match(String(note.data.text), /超时/);
});
