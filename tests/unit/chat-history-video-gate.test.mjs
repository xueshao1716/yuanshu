// 历史会话里的旧 video 块：远端链接不许再变成播放器（2026-11-07）。
//
// 真机背景：出片接口早期把 platform-outputs… 的临时签名链接直接存进了会话。
// 那些链接几小时到几天就过期；刷新历史时 Message.tsx 见到 http(s) 就走 /api/tv/media 代理，
// 于是聊天里留下一个永远转圈的黑框。修法是在**抽取层**就不产出远端地址：
// extractVideos 只留本地/同源（相对路径顺手归一成 /api/ws/file），
// extractMessages 里从工具结果回灌的视频同样过滤。
//
// 边界：影视页直播走 /api/tv/* + lib/tv.ts 直连原始 m3u8，不经过 extractVideos
//（下面有静态断言把这条边界钉住，防止以后有人顺手把直播也套上聊天判据）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractVideos, extractMessages } from "../../engine/session/utils.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REMOTE = "https://platform-outputs.agnes-ai.space/videos/agnes-video-2.5/task_yAihUekFawEgRbYdrGuyj9Cx5vqvWPb9.mp4";
const LOCAL_ABS = "D:\\pi-workspace\\生成物\\视频\\本地成片.mp4";
const LOCAL_REL = "生成物/视频/本地成片.mp4";
const LOCAL_WS = "/api/ws/file?path=" + encodeURIComponent("生成物/视频/本地成片.mp4");

const assistant = (content, id = "a1") => ({
  type: "message", id, parentId: "u1", timestamp: "2026-11-07T10:00:00.000Z",
  message: { role: "assistant", content },
});

const localRelFromUrl = (url) => decodeURIComponent(String(url).split("path=")[1] || "");

test("历史里的远端 video 块不产出可播地址，本地块保留", () => {
  assert.deepEqual(extractVideos([{ type: "video", url: REMOTE }]), [], "远端 video 块不能变成播放器");
  assert.deepEqual(extractVideos([{ type: "video", url: LOCAL_WS }]), [LOCAL_WS], "本地 /api/ws/file 照旧能播");
  // 本机绝对路径 / 相对路径要归一成窗口能直接加载的 /api/ws/file
  for (const local of [LOCAL_ABS, LOCAL_REL]) {
    const urls = extractVideos([{ type: "video", url: local }]);
    assert.equal(urls.length, 1, local);
    assert.match(urls[0], /^\/api\/ws\/file\?path=/, local);
    assert.match(localRelFromUrl(urls[0]), /生成物\/视频\/本地成片\.mp4$/, local);
  }
});

test("同一条历史消息里远端与本地并存：只留本地", () => {
  const msgs = extractMessages([assistant([
    { type: "text", text: "片子在远端，本地另存了一份" },
    { type: "video", url: REMOTE },
    { type: "video", url: LOCAL_WS },
  ])]);
  assert.deepEqual(msgs[0].videos, [LOCAL_WS]);
});

test("正文里的远端 mp4 不进 videos，正文里的本地交付路径照旧能播", () => {
  const remoteOnly = extractMessages([assistant([{ type: "text", text: `成片：${REMOTE}` }])]);
  assert.deepEqual(remoteOnly[0]?.videos || [], [], "正文外链不能变播放器");

  const localText = extractMessages([assistant([{ type: "text", text: `📎 交付: ${LOCAL_REL}` }])]);
  assert.ok(localText[0].videos.some(u => u.startsWith("/api/ws/file")), "本地交付路径要能播");
});

test("用户消息里存的远端 video 也不进播放器", () => {
  const entries = [{
    type: "message", id: "u1", parentId: null, timestamp: "2026-11-07T10:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "看这个" }, { type: "video", url: REMOTE }] },
  }];
  assert.deepEqual(extractMessages(entries)[0].videos, []);
});

test("媒体工具结果里的远端视频不回灌历史，本地落盘产物照旧回放", () => {
  const withTool = (url) => [
    {
      type: "message", id: "a_t", parentId: "u1", timestamp: "2026-11-07T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "generate_video", arguments: "{}" }] },
    },
    {
      type: "message", id: "t_c1", parentId: "a_t", timestamp: "2026-11-07T10:00:01.000Z",
      message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: `✅ 已生成 video：${url}` }] },
    },
  ];
  assert.deepEqual(extractMessages(withTool(REMOTE), "t_c1").find(m => m.role === "assistant").videos, [],
    "工具结果里的远端片子不能进历史播放器");
  assert.deepEqual(extractMessages(withTool(LOCAL_WS), "t_c1").find(m => m.role === "assistant").videos, [LOCAL_WS],
    "已落盘的片子刷新后还要能看");
});

test("直播/影视路径不依赖本抽取逻辑（Tv.tsx 只走 /api/tv，前端渲染层另做兜底）", () => {
  const tv = fs.readFileSync(path.join(ROOT, "frontend", "src", "pages", "Tv.tsx"), "utf8");
  assert.ok(!tv.includes("extractVideos"), "Tv.tsx 不得依赖聊天抽取层");
  assert.ok(!tv.includes("session/utils"), "直播页不引用会话抽取模块");
  assert.match(tv, /\/api\/tv\//, "片源仍走 /api/tv/*");
  // 聊天历史渲染层再做一层兜底：本地库里存量的远端链接（过滤上线前存的）也不能变播放器
  const message = fs.readFileSync(path.join(ROOT, "frontend", "src", "components", "chat", "Message.tsx"), "utf8");
  assert.match(message, /isChatPlayableUrl/, "Message.tsx 要过滤远端地址");
});
