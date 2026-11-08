// 出图链路：模型接口出的图**必须先存本地**，聊天里只发本地存档地址（2026-11-08）。
//
// 用户原话："聊天界面给我放的图的地址是模型平台的地址，不是我们约定的图存档本地。
// 所以刚有一个 gpt 平台的图，在一个终端可以看到，别的终端都看不到了。"
// 结论：本地存档是唯一交付路径。厂商地址（platform-outputs…）随时可能被关，
// 关了就永远没图看——下载失败按失败处理（{error} / 502），不发厂商链接、也不走代理。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deliverImageResult, assistantContentWithMedia } from "../../engine/media/api.mjs";
import { extractMessages } from "../../engine/session/utils.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REMOTE_IMAGE = "https://platform-outputs.agnes-ai.space/images/t2i/task_xxx/output_xxx.png";
const LOCAL_IMAGE = "/api/ws/file?path=" + encodeURIComponent("生成物/图片/海报_v2.213.11.png") + "&exp=1&sig=abc";
const DATA_IMAGE = "data:image/png;base64,iVBORw0KGgo=";

const assistant = (content, id = "a1") => ({
  type: "message", id, parentId: "u1", timestamp: "2026-11-08T10:00:00.000Z",
  message: { role: "assistant", content },
});

test("出图成功：结果与聊天块都是本地存档地址，不是厂商地址", async () => {
  const saves = [];
  const result = await deliverImageResult(
    { url: REMOTE_IMAGE, model: "relay/gpt-image-1", attempts: [{ model: "relay/gpt-image-1", outcome: "succeeded" }] },
    {
      prompt: "一张海报",
      saveArtifact: async (artifact) => { saves.push(artifact); return { url: LOCAL_IMAGE, local: true, reason: "" }; },
      verify: async () => ({ status: "matched", actualSize: "1024x1024" }),
    },
  );
  assert.equal(saves.length, 1, "生成完必须先下载");
  assert.equal(saves[0].type, "image");
  assert.equal(saves[0].url, REMOTE_IMAGE, "下载的是厂商给的原始地址");
  assert.equal(saves[0].prompt, "一张海报", "落盘要带提示词，往期才填得回来");
  assert.equal(result.url, LOCAL_IMAGE, "交付地址必须是本地存档");
  assert.equal(result.localized, true);
  assert.equal(result.error, undefined);
  assert.equal(result.model, "relay/gpt-image-1", "模型事实不能丢");
  assert.equal(result.verification.status, "matched");
  assert.ok(!JSON.stringify(result).includes("platform-outputs"), "结果里不许留厂商地址");

  const blocks = assistantContentWithMedia("画好了", [result]);
  const img = blocks.find(b => b.type === "image");
  assert.equal(img.url, LOCAL_IMAGE, "聊天块只能是 /api/ws/file");
  assert.ok(!JSON.stringify(blocks).includes("platform-outputs"), "块里不许出现厂商地址");
});

test("出图下载失败：按失败处理，没有任何可显示地址", async () => {
  const result = await deliverImageResult(
    { url: REMOTE_IMAGE, model: "relay/gpt-image-1" },
    {
      prompt: "一张海报",
      saveArtifact: async () => ({ url: REMOTE_IMAGE, local: false, reason: "下载失败 HTTP 502" }),
      verify: async () => undefined,
    },
  );
  assert.ok(result.error, "下载失败必须报错");
  assert.match(result.error, /没能存到本地/, "错误要说清没落盘");
  assert.match(result.error, /厂商/, "错误要说清原图在厂商侧可能失效");
  assert.equal(result.url, undefined, "不许退回厂商地址");
  assert.equal(result.unlocalized, true, "留未落盘标记供统计排查");
  assert.ok(!JSON.stringify(result).includes("platform-outputs"));

  const blocks = assistantContentWithMedia("", [result]);
  assert.ok(!blocks.some(block => block.type === "image"), "未落盘就没有图片块");
  assert.ok(!JSON.stringify(blocks).includes("platform-outputs"));
});

test("assistantContentWithMedia 兜底：远端图不许变成图片块（连代理也不给）", () => {
  const blocks = assistantContentWithMedia("画好了", [{ type: "image", url: REMOTE_IMAGE }]);
  assert.ok(!blocks.some(b => b.type === "image"), "远端图不能进聊天");
  const text = blocks.map(b => b.text || "").join("\n");
  assert.match(text, /画好了/);
  assert.match(text, /未落盘/, "要留一行说明");
  assert.match(text, /厂商/, "要说明原图可能已失效");
  assert.ok(!JSON.stringify(blocks).includes("platform-outputs"), "说明里也不带厂商地址");
});

test("历史消息：当年没落盘的远端图不展示，只留一行说明", () => {
  const msgs = extractMessages([assistant([{ type: "text", text: "画好了" }, { type: "image", url: REMOTE_IMAGE }])]);
  assert.deepEqual(msgs[0].images, [], "远端历史图不能渲染");
  assert.match(msgs[0].text, /画好了/);
  assert.match(msgs[0].text, /当年未落盘/, "要解释图为什么不见了");
  assert.ok(!msgs[0].text.includes("platform-outputs"), "不暴露厂商地址");
  assert.ok(!JSON.stringify(msgs[0]).includes("platform-outputs"));
});

test("历史消息：本地图与 data: 图照旧显示", () => {
  const msgs = extractMessages([assistant([{ type: "image", url: LOCAL_IMAGE }, { type: "image", url: DATA_IMAGE }])]);
  assert.deepEqual(msgs[0].images, [LOCAL_IMAGE, DATA_IMAGE]);
  assert.ok(!/未落盘/.test(msgs[0].text || ""), "正常图不该带未落盘说明");
});

test("历史消息：工具结果里的远端图也不回灌（generate_image 的旧记录）", () => {
  const entries = [
    {
      type: "message", id: "a_t", parentId: "u1", timestamp: "2026-11-08T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "generate_image", arguments: "{}" }] },
    },
    {
      type: "message", id: "t_c1", parentId: "a_t", timestamp: "2026-11-08T10:00:01.000Z",
      message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: `✅ 已生成 image：${REMOTE_IMAGE}` }] },
    },
  ];
  const msgs = extractMessages(entries, "t_c1");
  const a = msgs.find(m => m.role === "assistant");
  assert.deepEqual(a.images, [], "工具结果里的厂商图不能回灌历史");
  assert.match(a.text, /当年未落盘/);
  // 工具输出原文里仍会有厂商地址（那是历史事实、也是排查线索），但它不能再变成图片块。
  assert.ok(!msgs.some(m => (m.images || []).some(u => String(u).includes("platform-outputs"))));
});

test("源码契约：generateMediaAsync 走 deliverImageResult，/api/image 下载失败返回 502", () => {
  const src = fs.readFileSync(path.join(ROOT, "engine", "media", "api.mjs"), "utf8");
  const gen = src.slice(src.indexOf("export async function generateMediaAsync"), src.indexOf("export async function generateTTS"));
  assert.ok(gen.includes("deliverImageResult"), "出图分支必须先落盘再交付");
  assert.match(gen, /deliverImageResult\(result, \{ prompt: drawnPrompt/, "落盘要带上本次实际提示词");

  const save = src.slice(src.indexOf("export async function handleImageWithSave"), src.indexOf("function resolveVideoAuth"));
  assert.match(save, /!saved\.local/, "落盘失败要单独判");
  const failAt = save.indexOf("json(res, 502");
  const useAt = save.indexOf("payload.obj.image = saved.url");
  assert.ok(failAt > 0, "落盘失败按失败回报（502）");
  assert.ok(useAt > failAt, "必须先判失败再回写地址，失败时不得把厂商地址塞回响应");
  assert.match(save, /厂商/, "错误要说明厂商侧可能已失效");
});
