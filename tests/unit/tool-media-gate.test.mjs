// 第三方工具 / 扩展直传的 details.media：必须先过"本地才可播"的闸门（2026-11-07）。
//
// 背景：unified-chat 的 onToolEnd 与 server.mjs 的 tool_execution_end 以前把
// event.result.details.media **原样** push 进消息。扩展返回 platform-outputs… 这种临时签名链接时，
// 聊天里就直接多出一个播放器，几小时/几天后链接过期 → 永远转圈的黑框。
//
// 现在统一走 engine/media/embed.mjs 的 gateIncomingMedia：
//   · video 必须先过 isLocalPlayableUrl（本地相对路径顺手归一成 /api/ws/file）；
//   · 不是本地就**不生成播放块**，只留一行说明 + 原链接；
//   · 图片/音频行为不变；内置 generate_video 已 saveArtifact 落盘，本地地址直接放行。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gateIncomingMedia, explicitToolMedia, REMOTE_VIDEO_NOTE } from "../../engine/media/embed.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REMOTE = "https://platform-outputs.agnes-ai.space/videos/agnes-video-2.5/task_yAihUekFawEgRbYdrGuyj9Cx5vqvWPb9.mp4";
const LOCAL = "/api/ws/file?path=" + encodeURIComponent("生成物/视频/成片.mp4");

test("远端视频：不生成播放块，只留一行说明 + 原链接", () => {
  const gated = gateIncomingMedia({ type: "video", url: REMOTE, source: "tool" });
  assert.equal(gated.media, null, "远端视频绝不能进播放器");
  assert.match(gated.note, /未落盘/, "要说明还没落盘");
  assert.ok(gated.note.startsWith(REMOTE_VIDEO_NOTE));
  assert.ok(gated.note.includes(REMOTE), "说明里要带原链接，用户还能自己另存");
});

test("本地视频原样放行（内置 generate_video 已落盘，不受影响）", () => {
  const media = { type: "video", url: LOCAL, source: "tool", toolCallId: "x" };
  const gated = gateIncomingMedia(media);
  assert.equal(gated.note, "");
  assert.deepEqual(gated.media, media, "本地视频必须原样通过");
});

test("本地相对路径归一成 /api/ws/file 再放行（否则 <video> 相对路径会 404）", () => {
  const gated = gateIncomingMedia({ type: "video", url: "生成物/视频/成片.mp4" });
  assert.ok(gated.media, "本地相对路径是可播的");
  assert.match(gated.media.url, /^\/api\/ws\/file\?path=/);
  assert.match(decodeURIComponent(gated.media.url), /生成物\/视频\/成片\.mp4$/);
});

test("图片/音频不受影响：这次只收视频这条口子", () => {
  for (const media of [
    { type: "image", url: "https://cdn.example.com/a.png" },
    { type: "audio", url: "https://cdn.example.com/a.mp3" },
  ]) {
    const gated = gateIncomingMedia(media);
    assert.equal(gated.note, "");
    assert.deepEqual(gated.media, media);
  }
});

test("坏输入不产出播放块也不产出提示", () => {
  for (const bad of [null, undefined, {}, { type: "video" }, "x", 42]) {
    assert.deepEqual(gateIncomingMedia(bad), { media: null, note: "" }, String(bad));
  }
});

test("工具结果链路：explicitToolMedia 出来的远端视频同样被挡住", () => {
  const media = explicitToolMedia({ media: { type: "video", url: REMOTE } }, { id: "c1", name: "third_party_video" });
  assert.ok(media, "工具结果本身是合法媒体结构");
  const gated = gateIncomingMedia(media);
  assert.equal(gated.media, null);
  assert.ok(gated.note.includes(REMOTE));
});

test("两处直通点（unified-chat / server.mjs）都接了同一个闸门", () => {
  const chat = fs.readFileSync(path.join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const onEnd = chat.slice(chat.indexOf("const onToolEnd ="), chat.indexOf("const onCheckpoint ="));
  assert.ok(onEnd.includes("gateIncomingMedia(media)"), "unified-chat onToolEnd 必须过闸门");
  assert.ok(onEnd.includes('writer.push("note"'), "被挡下时要留一行说明");

  const server = fs.readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  const at = server.indexOf("event.result?.details?.media");
  assert.ok(at > 0, "server.mjs 里 details.media 直通点应还在原处");
  const block = server.slice(at, at + 900);
  assert.ok(block.includes("gateIncomingMedia(media)"), "server.mjs details.media 必须过闸门");
  assert.ok(block.includes('busEmit("note"'), "被挡下时前端也要收到说明");
});
