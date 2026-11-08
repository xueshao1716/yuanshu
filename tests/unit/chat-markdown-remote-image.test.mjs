// 前端兜底：聊天 Markdown 不再把远端图直接交给 /api/proxy/image（2026-11-08）。
//
// 代理只是"改个同源"，图仍然依赖厂商地址活着；厂商一关照样裂图。正文外链图应由后端
// 归档器换成 /api/ws/file；前端遇到漏网的远端地址只渲染一行文字 + 原链接，
// 不再让 <img> 去加载远端。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MARKDOWN = path.join(ROOT, "frontend", "src", "components", "chat", "Markdown.tsx");

test("Markdown.tsx 不再对远端图调用 imageProxyUrl / /api/proxy/image", () => {
  const src = fs.readFileSync(MARKDOWN, "utf8");
  assert.ok(!src.includes("imageProxyUrl"), "不许再 import/调用图片代理");
  assert.ok(!/['"`]\/api\/proxy\/image/.test(src), "不许手写图片代理地址（注释里说明历史可以）");
  const img = src.slice(src.indexOf("img({ src, alt })"), src.indexOf("table({ children })"));
  assert.ok(img.length > 0, "必须还能找到 img 渲染分支");
  assert.ok(!img.includes("imageProxyUrl"), "img 分支不许走代理");
  assert.ok(img.includes("外链图未归档"), "远端图要渲染成一行文字说明");
  assert.match(img, /<a\s+href=\{src\}/, "远端图最多保留文字原链接");
  assert.match(img, /\/api\/ws\/file/, "本地 /api/ws/file 必须仍被识别为可显示");
  assert.ok(img.includes("withFileToken"), "本地服务端图片仍要补 token");
});

test("本地/data: 图片不走远端分支（静态形状断言）", () => {
  const src = fs.readFileSync(MARKDOWN, "utf8");
  const img = src.slice(src.indexOf("img({ src, alt })"), src.indexOf("table({ children })"));
  // 远端判定必须排除 /api/ws/file；否则本地存档图会被当成外链图藏掉。
  const remoteLine = img.split("\n").find((line) => line.includes("const isRemote")) || "";
  assert.ok(remoteLine.length > 0, "必须能定位远端判定");
  assert.match(remoteLine, /api.*ws.*file/, "远端判定要排除 /api/ws/file");
  assert.match(img, /https\?:/, "远端判定只针对 http(s)/协议相对地址");
});

test("Live TV 的图片代理不受影响（只改聊天 Markdown，不碰影视页）", () => {
  const tv = fs.readFileSync(path.join(ROOT, "frontend", "src", "pages", "Tv.tsx"), "utf8");
  assert.match(tv, /imageProxyUrl/, "Tv.tsx 的封面代理保持原样");
  assert.match(tv, /\/api\/tv\//, "直播/影视仍走 /api/tv/*");
});
