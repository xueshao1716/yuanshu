// 聊天播放器只认本地/同源产物（2026-11-07）。
// 产品原则：远端图像/视频模型的生成物必须先下载到本地，再由窗口发出来——
// 远端签名链接几小时就过期，直接渲染成播放器只会得到一个永远转圈的黑框。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLocalPlayableUrl, extractPlayableMedia } from "../../engine/media/embed.mjs";
import { assistantContentWithMedia } from "../../engine/media/api.mjs";
import { resolveWorkspaceReadFile } from "../../engine/workspace-api.mjs";

const REMOTE_SIGNED = "https://platform-outputs.agnes-ai.space/videos/agnes-video-2.5/task_yAihUekFawEgRbYdrGuyj9Cx5vqvWPb9.mp4";

test("本地相对路径可以是播放块", () => {
  assert.equal(isLocalPlayableUrl("生成物/视频/小语-黑丝全身-v1-agnes-2026-11-07.mp4"), true);
  assert.equal(isLocalPlayableUrl("工程/分镜/clip.mp4"), true);
  assert.equal(isLocalPlayableUrl("交付/成片-2026-11-07.mp4"), true);
  assert.equal(isLocalPlayableUrl("生成物\\视频\\clip.mp4"), true);
});

test("/api/ws/file 可以是播放块（含签名变体）", () => {
  assert.equal(isLocalPlayableUrl("/api/ws/file?path=x.mp4"), true);
  assert.equal(isLocalPlayableUrl("/api/ws/file?path=x.mp4&exp=1&sig=abc"), true);
  assert.equal(isLocalPlayableUrl("http://127.0.0.1:8787/api/ws/file?path=x.mp4&token=t"), true);
});

test("远端签名链接不能当播放块", () => {
  assert.equal(isLocalPlayableUrl(REMOTE_SIGNED), false);
});

test("示例外链不能当播放块", () => {
  assert.equal(isLocalPlayableUrl("https://example.com/x.mp4"), false);
  assert.equal(isLocalPlayableUrl("https://cdn.example.com/foo.webm"), false);
  assert.equal(isLocalPlayableUrl(""), false);
});

test("正文里扫到的外链视频不再变成播放块，本机路径照旧能播", () => {
  const external = extractPlayableMedia("参考：https://example.com/x.mp4 ，还有 https://platform-outputs.agnes-ai.space/a/b.mp4");
  assert.deepEqual(external.videos, []);
  const local = extractPlayableMedia("做好了：📎 交付: 生成物/视频/clip.mp4");
  assert.ok(local.videos.some(u => u.startsWith("/api/ws/file")));
});

test("远端视频媒体只留一行说明 + 链接，本地视频才发播放器", () => {
  const remote = assistantContentWithMedia("片子在远端", [{ type: "video", url: REMOTE_SIGNED }]);
  assert.ok(!remote.some(b => b.type === "video"), "远端视频不能生成 video 块");
  const text = remote.filter(b => b.type === "text").map(b => b.text).join("\n");
  assert.match(text, /视频仍在远端，未落盘，可能过期/);
  assert.match(text, /\[打开远端视频\]/, "要留一个能点的链接");
  assert.ok(text.includes(REMOTE_SIGNED), "说明里要带原链接，用户还能自己另存");

  const local = assistantContentWithMedia("片子在本地", [{ type: "video", url: "/api/ws/file?path=%E7%94%9F%E6%88%90%E7%89%A9%2F%E8%A7%86%E9%A2%91%2Fclip.mp4" }]);
  assert.ok(local.some(b => b.type === "video"), "本地视频照旧要有播放器");
});

test("正文里的示例 mp4 也不再生成播放器", () => {
  const blocks = assistantContentWithMedia("示例：https://example.com/x.mp4", []);
  assert.ok(!blocks.some(b => b.type === "video"));
});

test("工作区文件服务：主根找不到时回落同机其它工作区根，越权路径仍拦住", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-ws-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, "D-pi-workspace");
  const alternate = path.join(root, "C-pi-workspace");
  const rel = "生成物/视频/小语-黑丝全身-v1-agnes-2026-11-07.mp4";
  fs.mkdirSync(path.join(primary, "生成物", "视频"), { recursive: true });
  fs.mkdirSync(path.join(alternate, "生成物", "视频"), { recursive: true });
  fs.writeFileSync(path.join(alternate, rel), Buffer.alloc(434442, 1));
  fs.writeFileSync(path.join(root, "secret.txt"), "不该被读到");

  // 只在备用根里 → 回落命中（真机 404 就是这一步没做）
  assert.equal(resolveWorkspaceReadFile(rel, { roots: [primary, alternate] }), path.join(alternate, rel));
  // 主根也有 → 主根优先，不跨根乱挑
  fs.writeFileSync(path.join(primary, rel), Buffer.alloc(8, 2));
  assert.equal(resolveWorkspaceReadFile(rel, { roots: [primary, alternate] }), path.join(primary, rel));
  // 路径穿越不许借回落绕过
  assert.equal(resolveWorkspaceReadFile("../secret.txt", { roots: [primary, alternate] }), null);
  // 绝对路径不跨根猜
  assert.equal(resolveWorkspaceReadFile(path.join(alternate, rel), { roots: [primary, alternate] }), null);
});
