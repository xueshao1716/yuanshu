import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "D:/pi-web";

test("pure image requests settle the model after one text turn", () => {
  const src = readFileSync(join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const start = src.indexOf("const chatOpts = {");
  const fn = src.slice(start, start + 2400);
  assert.match(fn, /tools:\s*skipTools \? false : toolDefs/);
  assert.match(fn, /maxTurns:\s*skipTools \? 1 : toolLoopMaxTurns\(\{ imageIntent, videoIntent \}\)/);
});

test("composite image requests keep the tool loop for file delivery", async () => {
  const { isPureImageRequest } = await import("../../engine/media-api.mjs");
  assert.equal(isPureImageRequest("画一张霓虹城市"), true);
  assert.equal(isPureImageRequest("生成图片并做成三页PPT，交付pptx文件"), false);
});
