// 读路径：旧会话正文里的 Markdown 外链图（2026-11-08）。
//
// extractMessages 是同步函数，不能在这里下载；它只查 记忆/运行时/外链图归档.json：
//   · 命中成功 → 换成本地 /api/ws/file；
//   · 命中失败/没命中 → 换一行文字。
// 硬要求：输出里绝不能留下原远端 URL——前端 ReactMarkdown 看到 http(s) 又会走代理，
// 厂商一关就裂图，等于没修。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractMessages } from "../../engine/session/utils.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REMOTE = "https://platform-outputs.agnes-ai.space/images/t2i/task_old/output_old.png";
const LOCAL = "/api/ws/file?path=" + encodeURIComponent("生成物/图片/2026-11-08/旧图.png") + "&exp=1&sig=old";
const NOW = new Date("2026-11-08T12:00:00.000Z");

const assistant = (content, id = "a1") => ({
  type: "message", id, parentId: "u1", timestamp: "2026-11-08T10:00:00.000Z",
  message: { role: "assistant", content },
});
const toolCall = (id, name = "generate_image") => ({
  type: "message", id: "a_" + id, parentId: "u1", timestamp: "2026-11-08T10:00:00.000Z",
  message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: "{}" }] },
});
const toolResult = (id, text) => ({
  type: "message", id: "t_" + id, parentId: "a_" + id, timestamp: "2026-11-08T10:00:01.000Z",
  message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }] },
});

function workspace(t, archive = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-session-mdimg-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  if (archive) {
    const file = path.join(dir, "记忆", "运行时", "外链图归档.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(archive, null, 2), "utf8");
  }
  return dir;
}

test("旧会话正文命中归档缓存：外链图换成本地地址，输出不再含远端 URL", (t) => {
  const wsRoot = workspace(t, {
    [REMOTE]: { local: LOCAL, size: 321, at: NOW.toISOString(), ok: true, reason: "" },
  });
  const msgs = extractMessages(
    [assistant([{ type: "text", text: "当年画好了：\n\n![海报](" + REMOTE + ")" }])],
    null,
    { wsRoot, now: NOW },
  );
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /!\[海报\]\(\/api\/ws\/file\?path=/);
  assert.ok(!msgs[0].text.includes("platform-outputs"), "正文里不许留厂商地址");
  assert.ok(!JSON.stringify(msgs[0]).includes("platform-outputs"), "整条消息都不许泄露厂商地址");
  assert.deepEqual(msgs[0].images, [LOCAL], "命中缓存的本地图仍要进 images 供界面渲染");
});

test("旧会话正文没命中缓存：换成一行文字，不展示远端图", (t) => {
  const wsRoot = workspace(t);
  const msgs = extractMessages(
    [assistant([{ type: "text", text: "画好了 ![海报](" + REMOTE + ")" }])],
    null,
    { wsRoot, now: NOW },
  );
  assert.match(msgs[0].text, /外链图没能归档/);
  assert.deepEqual(msgs[0].images, []);
  assert.ok(!JSON.stringify(msgs[0]).includes("platform-outputs"));
});

test("旧会话命中失败缓存（24h 内）：不重试、不显示，只留文字", (t) => {
  const wsRoot = workspace(t, {
    [REMOTE]: { local: "", size: 0, at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), ok: false, reason: "下载失败 HTTP 404" },
  });
  const msgs = extractMessages(
    [assistant([{ type: "text", text: "![海报](" + REMOTE + ")" }])],
    null,
    { wsRoot, now: NOW },
  );
  assert.match(msgs[0].text, /外链图没能归档/);
  assert.deepEqual(msgs[0].images, []);
  assert.ok(!msgs[0].text.includes("platform-outputs"));
});

test("工具正文里的外链图同样过缓存：本地命中就换地址，没命中就换文字", (t) => {
  const wsRoot = workspace(t, {
    [REMOTE]: { local: LOCAL, size: 10, at: NOW.toISOString(), ok: true, reason: "" },
  });
  const entries = [toolCall("c1"), toolResult("c1", "✅ 已生成 image：\n![成品](" + REMOTE + ")")];
  const msgs = extractMessages(entries, "t_c1", { wsRoot, now: NOW });
  const a = msgs.find((m) => m.role === "assistant");
  assert.ok(a, "工具结果要回灌到 assistant");
  assert.match(a.tools[0].output, /!\[成品\]\(\/api\/ws\/file\?path=/);
  assert.ok(!a.tools[0].output.includes("platform-outputs"));
  assert.deepEqual(a.images, [LOCAL], "工具结果里的本地图也要回灌历史");
  assert.ok(!JSON.stringify(a).includes("platform-outputs"));
});

test("源码契约：extractMessages 用缓存版归档器（同步、只读缓存），不在读历史时下载", () => {
  const src = fs.readFileSync(path.join(ROOT, "engine", "session", "utils.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export function extractMessages"), src.indexOf("return out;", src.indexOf("export function extractMessages")));
  assert.match(fn, /localizeMarkdownImagesCachedDetailed/, "读路径必须用缓存版");
  assert.match(fn, /readImageArchive/, "归档表只读一次，供整条会话复用");
  assert.ok(!/await\s+localizeMarkdownImages(?:Detailed)?\s*\(/.test(fn), "同步读路径不得等待下载");
  assert.ok(!fn.includes("saveArtifact"), "读历史时不该注入下载器");
});
