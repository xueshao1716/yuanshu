import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectMediaIntents, extractMediaPrompt, mediaAwarePrompt, mediaReadyNotice, explainMediaError, assistantContentWithMedia, isPureImageRequest, varyImagePrompt, initMediaApi, findMediaModel } from "../../engine/media-api.mjs";

test("给我画个你的样子 会走图像意图", () => {
  const intents = detectMediaIntents("给我画个你的样子");
  assert.ok(intents.some(i => i.type === "image"));
});

test("再给我用绘图模型画个你 不能剥成给我模型你", () => {
  const p = extractMediaPrompt("再给我用绘图模型画个你");
  assert.ok(p.length > 12, "出图提示词必须是一段能画的描述，不能剩几个残词");
  assert.ok(!/^给我模型你$/.test(p.trim()), "剥意图词不得只剩给我模型你");
  assert.ok(/小语|少女|肖像|portrait|自画像/i.test(p), "画个你必须走小语形象，不能把原句残渣送给绘图模型");
});

test("明确主体的配图仍保留主体，不套默认肖像", () => {
  const p = extractMediaPrompt("配图一只橘猫蹲在屋顶");
  assert.ok(p.includes("橘猫"));
  assert.ok(!/小语/.test(p), "用户已经指定主体时不要改成小语");
});

test("出图落盘块要带 url，刷新后还能从会话读出来", () => {
  const blocks = assistantContentWithMedia("画好了", [{ type: "image", url: "/api/ws/file?path=产物.png" }]);
  assert.ok(blocks.some(b => b.type === "text" && b.text.includes("画好了")));
  assert.ok(blocks.some(b => b.type === "image" && b.url.includes("产物.png")));
});

test("配图已生成必须写进主模型提示，但允许再交 SVG", () => {
  const url = "/api/ws/file?path=生成物/小语.png";
  const out = mediaAwarePrompt("给我画个你的样子", [{ type: "image", url, model: "agnes/agnes-image-2.5-flash" }]);
  assert.ok(out.includes("给我画个你的样子"), "原话必须保留");
  assert.ok(out.includes("配图已生成") || out.includes("已出图"), "必须告诉模型图已经有了");
  assert.ok(out.includes(url), "必须带上已展示的图路径");
  assert.ok(/SVG|矢量/.test(out), "任务需要时允许再交 SVG");
  assert.ok(!out.includes("禁止"), "不得禁止 write/bash/SVG");
});

test("出图还没回来时，主模型必须马上开口，不要自己 curl 出图接口", () => {
  const out = mediaAwarePrompt("画个你的样子", []);
  assert.ok(out.includes("图像模型"));
  assert.ok(/并行|正在/.test(out), "必须说明出图与思考并行");
  assert.ok(/开口|说明/.test(out), "必须马上开口，不要干等");
  assert.ok(!/调用工具/.test(out), "纯出图不要怂恿去调 bash/curl");
  assert.ok(/\/api\/image/.test(out), "必须写明不要自己 POST 出图接口");
  assert.ok(/\.token|令牌/.test(out), "必须写明不要读令牌");
  assert.ok(/5173|vite/i.test(out), "必须写明不要另起 Vite");
  assert.ok(/SVG|矢量|成品/.test(out), "任务需要时允许再交 SVG");
  assert.ok(!out.includes("禁止"), "不得写禁止二字去挡 SVG/write");
});

test("用绘图模型给我画个你 是纯出图，夹带写 PPT 就不是", () => {
  assert.equal(isPureImageRequest("用绘图模型给我画个你"), true);
  assert.equal(isPureImageRequest("画个你"), true);
  assert.equal(isPureImageRequest("画个你，再做成 PPT"), false);
  assert.equal(isPureImageRequest("今天天气怎么样"), false);
});

test("普通聊天不追加出图系统注", () => {
  assert.equal(mediaAwarePrompt("今天天气怎么样", []), "今天天气怎么样");
});

test("出图完成通知带路径且允许再交 SVG", () => {
  const n = mediaReadyNotice([{ type: "image", url: "/x.png" }]);
  assert.ok(n.includes("/x.png"));
  assert.ok(/SVG|矢量|成品/.test(n));
  assert.ok(!n.includes("禁止"));
});

test("fetch failed 要翻译成可读原因，不能把整轮聊打死成三个英文词", () => {
  const s = explainMediaError("fetch failed");
  assert.ok(/网络|代理/.test(s));
  assert.ok(!/^fetch failed$/i.test(s.trim()));
});

test("handleChat 出图不得挡住 agent.prompt，图好了再推前端并 nextTurn 告知", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "server.mjs"), "utf8");
  const start = src.indexOf("async function handleChat");
  assert.ok(start >= 0, "必须有 handleChat");
  const end = src.indexOf("\nasync function ", start + 10);
  const fn = src.slice(start, end > start ? end : undefined);
  const promptAt = fn.indexOf("agent.prompt(promptMsg");
  assert.ok(promptAt > 0, "必须调用 agent.prompt");
  const awaitMediaAt = fn.indexOf("await mediaPromise");
  if (awaitMediaAt >= 0) {
    assert.ok(awaitMediaAt > promptAt, "await mediaPromise 只能在 prompt 之后收尾，不能挡思考/工具/汇报");
  }
  const awareAt = fn.indexOf("mediaAwarePrompt");
  assert.ok(awareAt >= 0 && awareAt < promptAt, "出图意图提示必须在 prompt 前注入（此时图可以还没回来）");
  assert.ok(fn.includes('writer.push("media"'), "图好了要推给前端");
  assert.ok(fn.includes("mediaReadyNotice"), "出图完成后要用 nextTurn 告知主模型");
  assert.ok(fn.includes("正在出图"), "一开口就要让用户看见出图在并行，而不是空白干等");
  assert.ok(fn.includes("assistantContentWithMedia"), "原生通道出图也要写进会话 JSONL");
});

test("同一句画个你 两次送给绘图模型的词不能完全一样", () => {
  const base = extractMediaPrompt("画个你");
  const a = varyImagePrompt(base);
  const b = varyImagePrompt(base);
  assert.ok(/小语|少女/.test(a));
  assert.notEqual(a, b, "否则平台按 prompt 缓存，会反复吐同一张构图");
  assert.ok(/构图|变体|seed/i.test(a));
});

test("findMediaModel 出图优先 2.5，不拿列表里第一个 2.0 充数", () => {
  initMediaApi({
    getModelList: () => [
      { id: "agnes-image-2.0-flash", provider: "agnes", capabilities: { image: true } },
      { id: "agnes-image-2.5-flash", provider: "agnes", capabilities: { image: true } },
    ],
  });
  assert.equal(findMediaModel("image").id, "agnes-image-2.5-flash");
});

test("generateMediaAsync 必须把 prompt 变体交给 generateImage 并带进落盘对象", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "media-api.mjs"), "utf8");
  const start = src.indexOf("export async function generateMediaAsync");
  const fn = src.slice(start, start + 1600);
  assert.ok(fn.includes("varyImagePrompt"), "出图前必须打散固定词，避免平台缓存老图");
  assert.ok(/prompt:\s*drawnPrompt|prompt:\s*prompt/.test(fn) && fn.includes("varyImagePrompt"), "落盘对象要带本次实际提示词，文件名才能区分");
  assert.ok(fn.includes("generateVideo"), "视频意图必须走宿主 generateVideo，不能让模型自己翻密钥");
  assert.ok(fn.includes('"video"') || fn.includes("'video'"), "generateMediaAsync 必须有 video 分支");
});

test('普通海报提示词不混入小语肖像或伪 seed 文本', () => {
  for (const prompt of ['一片叶子，纯白背景', '磨砂玻璃后的击剑者，瑞士网格海报', '小语二字的文字标志']) {
    assert.equal(varyImagePrompt(prompt), prompt);
  }
});

test('媒体完成提示与会话落盘保留请求和实际尺寸，近似比例不能说严格达标', () => {
  const verification = { status: 'matched', requestedSize: '1472x832', requestedAspectRatio: '16:9', actualSize: '1312x736', exactSize: false, ratioExact: false };
  const media = [{ type: 'image', url: '/leaf.png', verification }];
  for (const text of [mediaAwarePrompt('画一张横版海报图', media), mediaReadyNotice(media)]) {
    assert.match(text, /1312x736/);
    assert.match(text, /近似/);
    assert.match(text, /1472x832/);
  }
  assert.deepEqual(assistantContentWithMedia('已生成', media).find(b => b.type === 'image').verification, verification);
  const bad = mediaReadyNotice([{ ...media[0], verification: { ...verification, status: 'mismatch' } }]);
  assert.match(bad, /未达标/);
});

test("图片意图应保留用户要求的画幅，并传给旁路生图", () => {
  assert.equal(detectMediaIntents("制作一张16:9横版产品海报并生成图片")[0].size, "1472x832");
  assert.equal(detectMediaIntents("画一张9:16竖版手机封面图")[0].size, "832x1472");
  assert.equal(detectMediaIntents("帮我画一只猫")[0].size, undefined);
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "media-api.mjs"), "utf8");
  const start = src.indexOf("export async function generateMediaAsync");
  const fn = src.slice(start, start + 1700);
  assert.ok(fn.includes("drawnPrompt, intent.size"), "旁路生图必须把 intent.size 传给 generateImage");
});

test("你自己写脚本做个视频 是视频意图，不要视频则不触发", () => {
  assert.ok(detectMediaIntents("你自己写脚本，做个视频，主题就是爱而不得").some(i => i.type === "video"));
  assert.ok(detectMediaIntents("生成视频：雨停之前").some(i => i.type === "video"));
  assert.ok(!detectMediaIntents("不要视频，只写剧本").some(i => i.type === "video"));
  assert.ok(!detectMediaIntents("今天天气怎么样").some(i => i.type === "video"));
});

test("要剧本并生成视频不能旁路出片，否则和 generate_video 叠着刷", () => {
  const intents = detectMediaIntents("给我做一个二创大话西游的剧本，孙悟空爱上铁扇公主，并生成视频，要有情感对话的");
  assert.ok(!intents.some(i => i.type === "video"), "有剧本时旁路会用原话当 prompt，叠出废片");
  assert.ok(detectMediaIntents("做个视频：大漠山道").some(i => i.type === "video"), "短出片指令仍可旁路");
});

test("视频旁路提示必须告诉模型宿主在出片，不要读密钥", () => {
  const out = mediaAwarePrompt("做个视频，主题爱而不得", []);
  assert.ok(out.includes("做个视频"), "原话必须保留");
  assert.ok(/视频模型|正在出片|并行/.test(out), "必须说明视频与思考并行");
  assert.ok(/auth\.json|\.token|令牌|密钥/.test(out), "必须写明不要读密钥");
  assert.ok(/generate_video/.test(out), "必须点名宿主工具");
});

test("视频已生成必须写进主模型提示和落盘块", () => {
  const url = "/api/ws/file?path=生成物/爱而不得.mp4";
  const out = mediaAwarePrompt("做个视频", [{ type: "video", url, model: "agnes/agnes-video-2.5-flash" }]);
  assert.ok(out.includes(url), "必须带上已展示的视频路径");
  assert.ok(/已出片|已生成/.test(out), "必须告诉模型片已经有了");
  const blocks = assistantContentWithMedia("片做好了", [{ type: "video", url }]);
  assert.ok(blocks.some(b => b.type === "text" && b.text.includes("片做好了")));
  assert.ok(blocks.some(b => b.type === "video" && b.url.includes("爱而不得.mp4")));
  const n = mediaReadyNotice([{ type: "video", url }]);
  assert.ok(n.includes(url));
});
