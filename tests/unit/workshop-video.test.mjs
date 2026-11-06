import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "frontend", "src");
const read = (...parts) => readFileSync(join(SRC, ...parts), "utf8");

test("创作工坊有视频页签，结构模仿 AI 绘画：出片框 + 技能提示词", () => {
  const workshop = read("pages", "Workshop.tsx");
  assert.ok(workshop.includes("'video'"), "必须有 video 页签");
  assert.ok(workshop.includes("视频工坊") || workshop.includes("AI 视频"), "页签名要点明视频");
  assert.ok(workshop.includes("<VideoGeneratePanel") || workshop.includes("<VideoPanel"), "出片框");
  assert.ok(workshop.includes("<VideoPrompt") || workshop.includes("<VideoWanxiang"), "技能提示词");
  assert.ok(workshop.includes("onUsePrompt"), "提示词要填进出片框");
});

test("出片框必须选视频模型，调 /api/media，播得了片子", () => {
  const panel = read("components", "panels", "VideoGeneratePanel.tsx");
  assert.ok(panel.includes("video"), "过滤 video 能力模型");
  assert.ok(panel.includes("MediaApi.video") || panel.includes("/api/media"), "走宿主视频通道");
  assert.ok(panel.includes("<video"), "结果要用播放器");
  assert.ok(panel.includes("seconds") || panel.includes("时长"), "能选时长");
  assert.ok(panel.includes("min-h-11"), "触控够大");
  assert.ok(panel.includes("智能填充") || panel.includes("expandPrompt"), "出片框要能智能扩写提示词");
});

test("视频提示词必须吃进镜头卡生成器，主体运镜还能改", () => {
  const prompt = read("components", "story", "VideoPrompt.tsx");
  const lib = read("lib", "video-prompt.mjs");
  assert.ok(prompt.includes("buildVideoPrompt"), "提示词组件必须用共享生成器");
  assert.ok(prompt.includes("填入出片框") || prompt.includes("填入"), "能填进出片框");
  assert.ok(prompt.includes("PromptSmartFill") || prompt.includes("智能填充") || prompt.includes("expandPrompt"), "镜头卡要能按一句话智能填");
  assert.match(prompt, /主体/);
  assert.match(prompt, /运镜/);
  assert.match(lib, /无字幕|无 BGM|无BGM/);
});

test("前端 MediaApi 和后端 handleMedia 要对上，出片后落盘", () => {
  const api = read("api.ts");
  assert.ok(api.includes("MediaApi") && api.includes("/api/media"), "前端要有 MediaApi.video");
  const media = readFileSync(join(ROOT, "engine", "media", "api.mjs"), "utf8");
  const fn = media.slice(media.indexOf("export async function handleMedia"));
  assert.ok(fn.includes("saveArtifact"), "工坊出片也要进生成物/视频");
});
