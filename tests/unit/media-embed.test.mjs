import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPlayableMedia, workspaceFileUrl } from "../../engine/media-embed.mjs";
import { extractVideos, extractMessages } from "../../engine/session-utils.mjs";
import { assistantContentWithMedia } from "../../engine/media-api.mjs";
import { coachToolFailure } from "../../engine/yuanshu-protocol.mjs";
import { createMediaToolExecutor } from "../../engine/media-channels.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("工作区 mp4 绝对路径必须收成可播的 /api/ws/file", () => {
  const url = workspaceFileUrl("D:\\pi-workspace\\生成物\\视频\\GPT-6概念短片.mp4");
  assert.match(url, /^\/api\/ws\/file\?path=/);
  assert.match(decodeURIComponent(url.split("path=")[1]), /生成物\/视频\/GPT-6概念短片\.mp4/);
});

test("括号尺寸说明不能粘进文件名", () => {
  const { videos } = extractPlayableMedia("📎 文件位置： D:\\pi-workspace\\生成物\\视频\\GPT-6概念短片.mp4（720P，10 秒，约 8MB）");
  assert.equal(videos.length, 1);
  assert.match(decodeURIComponent(videos[0]), /GPT-6概念短片\.mp4$/);
  assert.doesNotMatch(videos[0], /720P/);
});

test("extractPlayableMedia：正文、交付行、工具成功句都能捞出片子", () => {
  const text = [
    "文件在： D:\\pi-workspace\\生成物\\视频\\GPT-6概念短片.mp4（720P）",
    "📎 交付: 生成物/视频/GPT-6概念短片.mp4",
    "✅ 已生成 video：/api/ws/file?path=%E7%94%9F%E6%88%90%E7%89%A9%2F%E8%A7%86%E9%A2%91%2Fclip.mp4",
  ].join("\n");
  const { videos } = extractPlayableMedia(text);
  assert.ok(videos.some(u => decodeURIComponent(u).includes("GPT-6概念短片.mp4")));
  assert.ok(videos.some(u => u.startsWith("/api/ws/file")));
});

test("extractVideos 只写路径没有 type:video 块也能播", () => {
  const content = [{ type: "text", text: "📎 交付: 生成物/视频/GPT-6概念短片.mp4" }];
  const urls = extractVideos(content);
  assert.ok(urls.some(u => decodeURIComponent(u).includes("GPT-6概念短片.mp4")));
  const msgs = extractMessages([{
    type: "message", id: "a1",
    message: { role: "assistant", content },
  }]);
  assert.ok(msgs[0].videos?.some(u => decodeURIComponent(u).includes("GPT-6概念短片.mp4")));
});

test("assistantContentWithMedia 要把正文里的片子落成 video 块", () => {
  const blocks = assistantContentWithMedia("看这个 D:\\pi-workspace\\生成物\\视频\\GPT-6概念短片.mp4", []);
  assert.ok(blocks.some(b => b.type === "video" && decodeURIComponent(b.url).includes("GPT-6概念短片.mp4")));
});

test("generate_video 成功必须带 media 字段给宿主推播放器", async () => {
  const exec = createMediaToolExecutor({
    generateMediaAsync: async () => ({ type: "video", url: "/api/ws/file?path=clip.mp4" }),
  });
  const r = await exec("generate_video", { prompt: "GPT-6" });
  assert.equal(r.media?.type, "video");
  assert.match(r.media.url, /clip\.mp4/);
});

test("bash 打开本地片子不算违规，不训斥", () => {
  const b = coachToolFailure("bash", { command: "start D:\\pi-workspace\\生成物\\视频\\GPT-6概念短片.mp4" }, { text: "ok", isError: false });
  assert.equal(b.isError, false);
  assert.doesNotMatch(b.text, /不要用|禁止|训/);
});

test("协议和 pi 常驻提示讲能力和汇报，不写死播放方式", () => {
  const proto = readFileSync(join(ROOT, "engine", "yuanshu-protocol.mjs"), "utf8");
  assert.match(proto, /播放器|对话/);
  assert.match(proto, /判断|汇报/);
  assert.doesNotMatch(proto, /禁止 start|禁止.*播放器/);
  const loader = readFileSync(join(ROOT, "engine", "context-loader.mjs"), "utf8");
  assert.match(loader, /判断|汇报/);
  assert.match(loader, /播放器|对话.*播/);
  assert.doesNotMatch(loader, /视频播放【硬性】|禁止 bash start/);
});

test("聊天界面只从助手正文补片子，不能把读文档的旧媒体当本轮产物", () => {
  const chat = readFileSync(join(ROOT, "frontend", "src", "components", "ChatArea.tsx"), "utf8");
  assert.ok(chat.includes("scrapeVideos(s.text)"), "只允许从助手交付正文补视频");
  const toolEnd = chat.slice(chat.indexOf("case 'tool_end':"), chat.indexOf("case 'file':"));
  assert.ok(!toolEnd.includes('scrapeVideos'), "工具输出里的参考路径不能自动展示");
  const unified = readFileSync(join(ROOT, 'engine', 'unified-chat.mjs'), 'utf8');
  const onEnd = unified.slice(unified.indexOf('const onToolEnd ='), unified.indexOf('const onCheckpoint ='));
  assert.ok(!onEnd.includes('extractPlayableMedia'), '后端工具完成事件不得猜测媒体产物');
  assert.ok(onEnd.includes('explicitToolMedia'), '仅推送有来源的结构化媒体');
  const msg = readFileSync(join(ROOT, "frontend", "src", "components", "Message.tsx"), "utf8");
  const vid = msg.slice(msg.indexOf("<video"), msg.indexOf("<video") + 280);
  assert.ok(!vid.includes("max-w-[320px]"), "视频播放器要比配图缩略图大");
  assert.ok(/aspect-video|max-w-\[5/.test(vid), "要像播放器，不要邮票");
});

test("同一片子不同签名只能出一个播放器，media 追加也要按 path 去重", () => {
  const embed = readFileSync(join(ROOT, "frontend", "src", "lib", "media-embed.ts"), "utf8");
  assert.match(embed, /mediaPathKey|dedupeMediaUrls/, "要有按 path 去重");
  const chat = readFileSync(join(ROOT, "frontend", "src", "components", "ChatArea.tsx"), "utf8");
  assert.match(chat, /dedupeMediaUrls|mediaPathKey/, "流式追加 video 必须去重");
  const msg = readFileSync(join(ROOT, "frontend", "src", "components", "Message.tsx"), "utf8");
  assert.match(msg, /mediaPathKey|dedupeMediaUrls/, "历史消息播放器也要去重");
});
