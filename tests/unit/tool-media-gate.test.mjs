// 第三方工具 / 扩展直传的 details.media：必须先过"本地存档才算交付"的闸门。
//
// 2026-11-07 视频：不是本地就不生成播放块，只留一行说明 + 原链接。
// 2026-11-08 扩到图片：本地/data: 直接放行；远端 http(s) 先 saveArtifact 落盘，
//   落不下来这一条就不进聊天（返回 media:null + 一行说明，unlocalized:true 供统计排查）。
//   图片**没有**"远端链接"这种退路——厂商随时可能把地址关掉，关了就永远没图看。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gateIncomingMedia, explicitToolMedia, REMOTE_VIDEO_NOTE } from "../../engine/media/embed.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REMOTE_VIDEO = "https://platform-outputs.agnes-ai.space/videos/agnes-video-2.5/task_yAihUekFawEgRbYdrGuyj9Cx5vqvWPb9.mp4";
const REMOTE_IMAGE = "https://platform-outputs.agnes-ai.space/images/t2i/task_xxx/output_xxx.png";
const LOCAL_VIDEO = "/api/ws/file?path=" + encodeURIComponent("生成物/视频/成片.mp4");
const LOCAL_IMAGE = "/api/ws/file?path=" + encodeURIComponent("生成物/图片/海报.png") + "&exp=1&sig=abc";

test("远端视频：不生成播放块，只留一行说明 + 原链接", async () => {
  const gated = await gateIncomingMedia({ type: "video", url: REMOTE_VIDEO, source: "tool" });
  assert.equal(gated.media, null, "远端视频绝不能进播放器");
  assert.match(gated.note, /未落盘/, "要说明还没落盘");
  assert.ok(gated.note.startsWith(REMOTE_VIDEO_NOTE));
  assert.ok(gated.note.includes(REMOTE_VIDEO), "说明里要带原链接，用户还能自己另存");
  assert.equal(gated.unlocalized, false, "视频不受图片那条未落盘标记影响");
});

test("本地视频原样放行（内置 generate_video 已落盘，不受影响）", async () => {
  const media = { type: "video", url: LOCAL_VIDEO, source: "tool", toolCallId: "x" };
  const gated = await gateIncomingMedia(media);
  assert.equal(gated.note, "");
  assert.deepEqual(gated.media, media, "本地视频必须原样通过");
});

test("本地相对路径归一成 /api/ws/file 再放行（否则 <video> 相对路径会 404）", async () => {
  const gated = await gateIncomingMedia({ type: "video", url: "生成物/视频/成片.mp4" });
  assert.ok(gated.media, "本地相对路径是可播的");
  assert.match(gated.media.url, /^\/api\/ws\/file\?path=/);
  assert.match(decodeURIComponent(gated.media.url), /生成物\/视频\/成片\.mp4$/);
});

test("本地/同源/data: 图片直接放行，不下载", async () => {
  for (const url of [LOCAL_IMAGE, "data:image/png;base64,iVBORw0KGgo=", "生成物/图片/海报.png"]) {
    const gated = await gateIncomingMedia({ type: "image", url }, { saveArtifact: async () => { throw new Error("不该下载本地图"); } });
    assert.ok(gated.media, url);
    assert.equal(gated.note, "", url);
    assert.equal(gated.unlocalized, false, url);
    assert.equal(gated.media.url.startsWith("/api/ws/file") || gated.media.url.startsWith("data:"), true, url);
  }
});

test("远端图片：先 saveArtifact 落盘，再发本地地址", async () => {
  const saves = [];
  const gated = await gateIncomingMedia({ type: "image", url: REMOTE_IMAGE, source: "tool" }, {
    saveArtifact: async (artifact) => { saves.push(artifact); return { url: LOCAL_IMAGE, local: true, reason: "" }; },
  });
  assert.equal(saves.length, 1, "远端图片必须先下载");
  assert.equal(saves[0].type, "image");
  assert.equal(saves[0].url, REMOTE_IMAGE);
  assert.ok(gated.media, "落盘成功要发图");
  assert.equal(gated.media.url, LOCAL_IMAGE, "块里只能是本地存档地址");
  assert.equal(gated.unlocalized, false);
});

test("远端图片下载失败：这一条不进聊天，只留一行说明且不带厂商地址", async () => {
  const gated = await gateIncomingMedia({ type: "image", url: REMOTE_IMAGE }, {
    saveArtifact: async () => ({ url: REMOTE_IMAGE, local: false, reason: "下载失败 HTTP 403" }),
  });
  assert.equal(gated.media, null, "未落盘的图绝不能显示");
  assert.equal(gated.unlocalized, true, "要留未落盘标记供统计排查");
  assert.match(gated.note, /没能存到本地/, "要说明为什么没图");
  assert.match(gated.note, /厂商/, "要说明厂商地址可能随时失效");
  assert.ok(!JSON.stringify(gated).includes(REMOTE_IMAGE), "绝不能把厂商地址带进聊天");
});

test("远端图片落盘抛异常：同样不进聊天", async () => {
  const gated = await gateIncomingMedia({ type: "image", url: REMOTE_IMAGE }, {
    saveArtifact: async () => { throw new Error("连接被重置"); },
  });
  assert.equal(gated.media, null);
  assert.equal(gated.unlocalized, true);
  assert.ok(!JSON.stringify(gated).includes(REMOTE_IMAGE));
});

test("没有落盘实现时不发远端图片（不给自己留侥幸）", async () => {
  const gated = await gateIncomingMedia({ type: "image", url: REMOTE_IMAGE });
  assert.equal(gated.media, null);
  assert.equal(gated.unlocalized, true);
});

test("音频不受影响（这次只收图/视频两条口子）", async () => {
  const media = { type: "audio", url: "https://cdn.example.com/a.mp3" };
  const gated = await gateIncomingMedia(media);
  assert.equal(gated.note, "");
  assert.deepEqual(gated.media, media);
});

test("坏输入不产出媒体块也不产出提示", async () => {
  for (const bad of [null, undefined, {}, { type: "video" }, "x", 42]) {
    assert.deepEqual(await gateIncomingMedia(bad), { media: null, note: "", unlocalized: false }, String(bad));
  }
});

test("工具结果链路：explicitToolMedia 出来的远端视频同样被挡住", async () => {
  const media = explicitToolMedia({ media: { type: "video", url: REMOTE_VIDEO } }, { id: "c1", name: "third_party_video" });
  assert.ok(media, "工具结果本身是合法媒体结构");
  const gated = await gateIncomingMedia(media);
  assert.equal(gated.media, null);
  assert.ok(gated.note.includes(REMOTE_VIDEO));
});

test("两处直通点（unified-chat / server.mjs）都接了同一个异步闸门", () => {
  const chat = fs.readFileSync(path.join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const onEnd = chat.slice(chat.indexOf("const onToolEnd ="), chat.indexOf("const onCheckpoint ="));
  assert.ok(onEnd.includes("deliverGatedToolMedia(media"), "unified-chat onToolEnd 必须过闸门");
  assert.match(chat, /gateIncomingMedia\(media, \{ saveArtifact \}\)/, "闸门本体要真的接上 saveArtifact");
  assert.ok(chat.includes('writer.push("note"'), "被挡下时要留一行说明");

  const server = fs.readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  const at = server.indexOf("event.result?.details?.media");
  assert.ok(at > 0, "server.mjs 里 details.media 直通点应还在原处");
  const block = server.slice(at, at + 1200);
  assert.match(block, /gateIncomingMedia\(media, \{ saveArtifact \}\)/, "server.mjs details.media 必须过闸门");
  assert.ok(block.includes('busEmit("note"'), "被挡下时前端也要收到说明");
});
