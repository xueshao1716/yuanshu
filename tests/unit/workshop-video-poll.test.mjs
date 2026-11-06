import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("工坊出片不能一条请求干等轮询，否则 Cloudflare 会 524", () => {
  const media = readFileSync(join(ROOT, "engine", "media", "api.mjs"), "utf8");
  const handle = media.slice(media.indexOf("export async function handleMedia"));
  assert.ok(handle.includes("task_id"), "带 task_id 才去查进度");
  assert.ok(handle.includes("202") || handle.includes("pending"), "创建成功必须马上返回，不能卡到片好");
  assert.ok(!/for\s*\(\s*let i = 0; i < 36/.test(handle), "handleMedia 里不得再死循环等 180 秒");
});

test("前端必须先拿 task_id 再短轮询，不能一条 POST 等到 524", () => {
  const panel = readFileSync(join(ROOT, "frontend", "src", "components", "panels", "VideoGeneratePanel.tsx"), "utf8");
  assert.ok(panel.includes("task_id"), "出片框要拿任务号");
  assert.ok(/for\s*\(|while\s*\(/.test(panel), "出片框要自己轮询");
  assert.ok(!panel.includes("timeoutMs: 220000") || panel.includes("task_id"), "不要靠拉长超时硬扛 524");
});

test("generateVideo 聊天旁路仍可自己轮询，但创建和查询要拆开", () => {
  const media = readFileSync(join(ROOT, "engine", "media", "api.mjs"), "utf8");
  assert.ok(media.includes("export async function startVideoJob") || media.includes("export async function createVideoJob"), "创建任务要单独导出");
  assert.ok(media.includes("export async function checkVideoJob") || media.includes("export async function pollVideoJob"), "查进度要单独导出");
});
