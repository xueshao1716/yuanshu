import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { videoCreateBody, videoPollPath } from "../../engine/video-request.mjs";

test("2.5 纯文生视频必须带 mode=text，不能只丢 model+prompt", () => {
  const body = videoCreateBody("agnes-video-2.5-flash", "GPT-6 概念片");
  assert.equal(body.model, "agnes-video-2.5-flash");
  assert.equal(body.prompt, "GPT-6 概念片");
  assert.equal(body.mode, "text");
});

test("2.5 flash 和 2.5 正式版都要 mode，v2.0 不强制", () => {
  assert.equal(videoCreateBody("agnes-video-2.5", "x").mode, "text");
  assert.equal(videoCreateBody("agnes-video-2.5-flash", "x").mode, "text");
  assert.equal(videoCreateBody("agnes-video-v2.0", "x").mode, undefined);
});

test("有首尾帧走 keyframe，有参考素材走 reference，显式 mode 优先", () => {
  assert.equal(videoCreateBody("agnes-video-2.5-flash", "x", { first_frame: "http://a" }).mode, "keyframe");
  assert.equal(videoCreateBody("agnes-video-2.5-flash", "x", { images: ["http://a"] }).mode, "reference");
  assert.equal(videoCreateBody("agnes-video-2.5-flash", "x", { mode: "reference", images: ["http://a"] }).mode, "reference");
});

test("非法 mode 回落到 text，不把 text-to-video 这种词原样上送", () => {
  assert.equal(videoCreateBody("agnes-video-2.5-flash", "x", { mode: "text-to-video" }).mode, "text");
  assert.equal(videoCreateBody("agnes-video-2.5-flash", "x", { mode: "pro" }).mode, "text");
});

test("2.5 轮询必须带 model_name，否则非 text 模式查不到", () => {
  const path = videoPollPath("vid-1", "agnes-video-2.5-flash");
  assert.match(path, /video_id=vid-1/);
  assert.match(path, /model_name=agnes-video-2\.5-flash/);
});

test("startVideoJob 创建体必须走 videoCreateBody", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "engine", "media", "api.mjs"), "utf8");
  const start = src.indexOf("export async function startVideoJob");
  const fn = src.slice(start, src.indexOf("export async function handleMedia", start));
  assert.ok(fn.includes("videoCreateBody"), "宿主转发层必须组好 mode，不能只 POST model+prompt");
  assert.ok(fn.includes("videoPollPath"), "轮询也要带 model_name");
});
