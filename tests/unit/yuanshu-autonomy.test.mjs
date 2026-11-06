import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiMediaTools } from "../../engine/pi-media-tools.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("pi 首轮就要有出片工具，不能只剩 read/write/edit/bash", () => {
  const src = readFileSync(join(ROOT, "engine", "session", "manager.mjs"), "utf8");
  assert.ok(src.includes("generate_video"), "主驾也要能自己出片，不能只会 bash 考古");
  const boot = src.slice(src.indexOf("MIN_BOOTSTRAP"), src.indexOf("MIN_BOOTSTRAP") + 800);
  assert.ok(boot.includes("generate_video") || src.includes("FIRST_TURN"), "首轮不能把出片工具藏起来");
});

test("createSessionAgent 必须挂上宿主媒体工具", () => {
  const src = readFileSync(join(ROOT, "engine", "session", "manager.mjs"), "utf8");
  assert.ok(src.includes("initPiMediaTools") || src.includes("createPiMediaTools") || src.includes("piMediaTools"), "pi 自定义工具表要有密文出片通道");
});

test("createPiMediaTools 挂出 generate_video", async () => {
  const Type = { Object: (x) => x, String: (x) => x, Optional: (x) => x, Any: (x) => x };
  const tools = createPiMediaTools({
    Type,
    generateMediaAsync: async () => ({ type: "video", url: "/api/ws/file?path=clip.mp4" }),
    getModelList: () => [],
  });
  const video = tools.find((t) => t.name === "generate_video");
  assert.ok(video);
  const r = await video.execute("1", { prompt: "GPT-6" });
  assert.match(r.content[0].text, /clip\.mp4/);
});
