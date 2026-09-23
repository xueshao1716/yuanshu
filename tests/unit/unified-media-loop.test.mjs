// 统一通道出图空转 20 轮：agnes 等非原生模型不走 pi agent，
// 旧代码等 unifiedChat 整段跑完才推图；满 20 轮直接 error，图都丢了。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  toolLoopMaxTurns,
  splitAssistantPayload,
  lastPartialAssistantText,
  toolCallLoopKey,
} from "../../engine/unified-chat.mjs";
import { detectMediaIntents, mediaAwarePrompt } from "../../engine/media-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("给我用绘图模型画个你吧 是图像意图", () => {
  assert.ok(detectMediaIntents("给我用绘图模型画个你吧").some(i => i.type === "image"));
});

test("出图意图把工具循环压到 6 轮，普通聊天仍是 20", () => {
  assert.equal(toolLoopMaxTurns({ imageIntent: true }), 6);
  assert.equal(toolLoopMaxTurns({ videoIntent: true }), 20);
  assert.equal(toolLoopMaxTurns({}), 20);
  assert.equal(toolLoopMaxTurns({ maxTurns: 3, imageIntent: true }), 3);
});

test("带 tool_calls 的中间轮次也要把思考/正文拆出来给前端", () => {
  const { think, text } = splitAssistantPayload({
    content: "<think>先让图像模型出图</think>\n好，正在画。",
    reasoning_content: "",
    tool_calls: [{ id: "1", function: { name: "write", arguments: "{}" } }],
  });
  assert.equal(think, "先让图像模型出图");
  assert.equal(text, "好，正在画。");
});

test("满轮时回收带 tool_calls 的助手正文，不当成没输出", () => {
  const history = [
    { role: "user", content: "画个你" },
    { role: "assistant", content: "图马上出来。", tool_calls: [{ id: "1" }] },
    { role: "tool", content: "ok" },
  ];
  assert.equal(lastPartialAssistantText(history), "图马上出来。");
});

test("文件写入按完整参数区分，curl 绘图接口仍保留防空转签名", () => {
  const a = toolCallLoopKey("write", { path: "a.svg", content: "<svg><rect/></svg>" });
  const b = toolCallLoopKey("write", { path: "b.svg", content: "<svg><circle/></svg>" });
  assert.notEqual(a, b);
  const curlA = toolCallLoopKey("bash", { command: "curl https://x/v1/images/generations" });
  const curlB = toolCallLoopKey("bash", { command: "curl -X POST https://y/v1/images/generations -d '{}'" });
  assert.equal(curlA, curlB);
  const readA = toolCallLoopKey("read", { path: "a.txt" });
  const readB = toolCallLoopKey("read", { path: "b.txt" });
  assert.notEqual(readA, readB);
});

test("handleUnifiedChat：出图与对话并行，满轮也要把图推出去", () => {
  const src = readFileSync(join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const start = src.indexOf("export async function handleUnifiedChat");
  assert.ok(start >= 0, "必须有 handleUnifiedChat");
  const end = src.indexOf("\nexport async function ", start + 10);
  const end2 = src.indexOf("\nexport function ", start + 10);
  const cut = [end, end2].filter(i => i > start).sort((a, b) => a - b)[0];
  const fn = src.slice(start, cut || undefined);

  assert.ok(fn.includes("mediaAwarePrompt"), "兑底通道也必须告诉模型图像旁路正在出图");
  assert.ok(fn.includes("正在出图"), "一开口就要让用户看见出图在并行");
  assert.ok(fn.includes("videoIntent") && fn.includes("正在出片"), "视频意图也要并行出片并压轮数");
  assert.ok(fn.includes('writer.push("media"'), "图好了要推给前端");

  const unifiedAt = fn.lastIndexOf("await unifiedChat(chatModel");
  assert.ok(unifiedAt > 0, "必须调用 unifiedChat");
  const awaitMediaAt = fn.indexOf("await mediaPromise");
  if (awaitMediaAt >= 0) {
    assert.ok(awaitMediaAt > unifiedAt, "不得先等出图再对话");
  }
  assert.ok(/mediaPromise\.then/.test(fn), "图好了立刻推，不要等 20 轮结束");
  assert.ok(fn.includes("assistantContentWithMedia"), "出图必须写进会话 JSONL，不能只活在 SSE");
  const appendAt = Math.max(fn.lastIndexOf("entry.sm.appendMessage({ role: \"assistant\""), fn.lastIndexOf("persistYuanshuAssistant"));
  const deliverAt = fn.lastIndexOf("await deliverUnifiedMedia()");
  assert.ok(appendAt > 0 && deliverAt > 0 && deliverAt < appendAt, "先等旁路出图再落盘，助手消息才能带上图");

  const errAt = fn.indexOf("if (!result || result.error)", unifiedAt);
  assert.ok(errAt > unifiedAt, "必须处理 unifiedChat 错误");
  const afterErr = fn.slice(errAt, errAt + 800);
  assert.ok(/deliverUnifiedMedia|mediaDelivered|await mediaPromise/.test(afterErr), "20 轮停了也要把已经生成的图推出去");
  assert.ok(fn.includes("isPureImageRequest"), "纯出图请求必须识别出来");
  assert.ok(/tools:\s*false/.test(fn) || /skipTools \? false/.test(fn), "纯出图不要把 bash/dsh 交给模型");
});

test("unifiedChat 工具循环用 maxTurns，中间轮次立刻 onThink/onDelta", () => {
  const src = readFileSync(join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const start = src.indexOf("export async function unifiedChat");
  const end = src.indexOf("\nexport async function ", start + 10);
  const fn = src.slice(start, end > start ? end : undefined);
  assert.ok(fn.includes("toolLoopMaxTurns"), "轮数上限必须可按出图意图收紧");
  assert.ok(fn.includes("onThink") && fn.includes("onDelta"), "中间轮次要把思考/正文立刻推出去");
  assert.ok(fn.includes("runYuanshuToolRound"), "画图类 write/bash 防空转收在元枢工具轮");
  assert.ok(fn.includes("lastPartialAssistantText"), "满轮要回收中间正文，不要只丢 20 轮错误");
});

test("出图旁路提示不能禁止工具，也不能让模型以为必须自己去调绘图 API", () => {
  const out = mediaAwarePrompt("给我用绘图模型画个你吧", []);
  assert.ok(/并行|正在/.test(out));
  assert.ok(!out.includes("禁止"));
  assert.ok(/\/api\/image/.test(out), "必须拆穿自己去调绘图 API 这条弯路");
});
