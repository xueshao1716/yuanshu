// 写路径：assistant 消息落库/广播前，正文外链图必须先归档（2026-11-08）。
//
// 新消息不能等下次刷新才修：模型正文里写了 `![图](https://厂商…)`，落库前就要下载到
// 生成物/图片/，把正文换成 /api/ws/file；下载失败/超限只留一行文字，绝不发厂商地址。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { localizeAssistantMarkdown, persistYuanshuAssistantLocalized } from "../../engine/yuanshu-session.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REMOTE = "https://platform-outputs.agnes-ai.space/images/t2i/task_new/output_new.png";
const LOCAL = "/api/ws/file?path=" + encodeURIComponent("生成物/图片/2026-11-08/新图.png") + "&exp=1&sig=new";
const NOW = new Date("2026-11-08T12:00:00.000Z");

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-write-mdimg-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

test("persistYuanshuAssistantLocalized：落库前把远端正文图换成存档地址", async (t) => {
  const wsRoot = tempRoot(t);
  const saved = [];
  const sm = { appendMessage: (message) => { saved.push(message); return message; } };
  await persistYuanshuAssistantLocalized(
    sm,
    "画好了：\n\n![海报](" + REMOTE + ")",
    [],
    {},
    {
      wsRoot,
      now: NOW,
      saveArtifact: async (artifact) => {
        assert.equal(artifact.type, "image");
        assert.equal(artifact.url, REMOTE);
        return { url: LOCAL, local: true, reason: "" };
      },
    },
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0].role, "assistant");
  const text = saved[0].content.map((b) => b.text || "").join("\n");
  assert.match(text, /!\[海报\]\(\/api\/ws\/file\?path=/);
  assert.ok(!JSON.stringify(saved[0]).includes("platform-outputs"), "落库消息里不许有厂商地址");
});

test("persistYuanshuAssistantLocalized：图片块里的远端地址也走同一归档器", async (t) => {
  const wsRoot = tempRoot(t);
  const saved = [];
  const sm = { appendMessage: (message) => { saved.push(message); return message; } };
  // sdkSafeAssistantBlocks 会把 image 块改写成 markdown（这是落盘的安全形态），
  // 归档器必须在改写后继续把远端地址换成本地地址。
  await persistYuanshuAssistantLocalized(
    sm,
    [{ type: "image", url: REMOTE }],
    [],
    {},
    { wsRoot, now: NOW, saveArtifact: async () => ({ url: LOCAL, local: true, reason: "" }) },
  );
  const text = saved[0].content.map((b) => b.text || "").join("\n");
  assert.ok(text.includes(LOCAL), "图片块最终也要落成本地地址");
  assert.ok(!JSON.stringify(saved[0]).includes("platform-outputs"));
});

test("localizeAssistantMarkdown：失败/超限只留文字，不把远端 URL 交给广播", async (t) => {
  const wsRoot = tempRoot(t);
  const r = await localizeAssistantMarkdown(
    "图一 ![一](" + REMOTE + ") 图二 ![二](https://vendor.example.com/second.png)",
    {
      wsRoot,
      now: NOW,
      maxPerMessage: 1,
      saveArtifact: async () => ({ url: REMOTE, local: false, reason: "下载失败 HTTP 502" }),
    },
  );
  assert.equal(r.attempted, 1, "maxPerMessage=1 只尝试一张");
  assert.equal(r.failed, 1);
  assert.equal(r.skipped, 1, "第二张直接文字说明");
  assert.ok(!r.text.includes("platform-outputs"));
  assert.ok(!r.text.includes("vendor.example.com"));
  assert.match(r.text, /外链图没能归档/);
});

test("源码契约：unified-chat 在最终落库/广播前调用归档器", () => {
  const src = fs.readFileSync(path.join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export async function handleUnifiedChat"));
  assert.match(fn, /localizeAssistantText/, "要有统一的正文归档入口");
  assert.match(fn, /persistYuanshuAssistantLocalized|localizeAssistantMarkdown/, "写路径要接归档器");
  const localizeAt = fn.indexOf("const localizedFinal = await localizeAssistantText(text)");
  const finalPersistAt = fn.lastIndexOf("persistYuanshuAssistant(entry.sm, assistantContentWithMedia(text");
  const finalDoneAt = fn.lastIndexOf('writer.push("done"');
  assert.ok(localizeAt > 0, "最终归档必须真的执行");
  assert.ok(localizeAt < finalPersistAt, "落库前必须先归档");
  assert.ok(localizeAt < finalDoneAt, "done 广播前必须先归档");
  assert.ok(!/persistYuanshuAssistant\(entry\.sm, result\.text/.test(fn), "不得把未归档的 result.text 直接落库");
});
