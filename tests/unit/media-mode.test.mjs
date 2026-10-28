// 出图由谁发起：默认她驱动；subject=self 走人设（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { directMediaMode, seedMediaMode } from "../../engine/media-mode.mjs";
import { createMediaToolExecutor } from "../../engine/media-channels.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "mmode-"));

test("默认：不抢跑（她驱动）", () => {
  assert.equal(directMediaMode(ws()), false);
});

test("配置 direct=true 才回到抢跑", () => {
  const root = ws();
  seedMediaMode(root, true);
  assert.equal(directMediaMode(root), true);
  seedMediaMode(root, false);
});

test("坏配置不炸，回落默认", () => {
  const root = ws();
  fs.mkdirSync(path.join(root, "记忆", "运行时"), { recursive: true });
  fs.writeFileSync(path.join(root, "记忆", "运行时", "出图.json"), "{不是 json", "utf8");
  assert.equal(directMediaMode(root), false);
});

test("generate_image subject=self：提示词由人设拼（含【小语自画像】标记与附加要求）", async () => {
  const root = ws();
  fs.mkdirSync(path.join(root, "记忆"), { recursive: true });
  fs.writeFileSync(path.join(root, "记忆", "人格定义.json"), JSON.stringify({ name: "小语", age: 20, gender: "female" }), "utf8");

  let seenPrompt = "";
  const exec = createMediaToolExecutor({
    wsRoot: root,
    getModelList: () => [],
    generateMediaAsync: async (_intent, prompt) => { seenPrompt = String(prompt); return { url: "http://x/y.png", type: "image" } },
  });
  await exec("generate_image", { subject: "self", prompt: "穿黑色风衣站在雨里" });
  assert.match(seenPrompt, /【小语自画像】/);
  assert.match(seenPrompt, /穿黑色风衣站在雨里/);
  assert.match(seenPrompt, /20岁/);
});

test("普通出图不受影响（有自己的 prompt 就原样用）", async () => {
  const root = ws();
  let seenPrompt = "";
  const exec = createMediaToolExecutor({
    wsRoot: root,
    getModelList: () => [],
    generateMediaAsync: async (_intent, prompt) => { seenPrompt = String(prompt); return { url: "http://x/z.png", type: "image" } },
  });
  await exec("generate_image", { prompt: "一只橘猫坐在窗台上" });
  assert.equal(seenPrompt, "一只橘猫坐在窗台上");
});
