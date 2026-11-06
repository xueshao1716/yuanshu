// 宿主密文通道：模型不见明文密钥，但能用已配置的图/视频/配音通道干活。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createUnifiedToolExecutor } from "../../engine/tools/unified-tools.mjs";
import { safeJoin } from "../../engine/tools/security.mjs";
import {
  MEDIA_TOOL_SCHEMAS,
  listHostChannels,
  formatSensitiveHint,
  createMediaToolExecutor,
} from "../../engine/media/channels.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SAMPLE_MODELS = [
  { provider: "agnes", id: "agnes-video-2.5-flash", capabilities: { video: true } },
  { provider: "agnes", id: "agnes-image-2.5-flash", capabilities: { image: true } },
  { provider: "xiaomi-token-plan-cn", id: "mimo-v2.5-tts", capabilities: { tts: true } },
  { provider: "zhipu-paid", id: "glm-5.3-flash", capabilities: {} },
];

test("listHostChannels 只报通道名和能力，绝不带 key", () => {
  const cat = listHostChannels({ getModelList: () => SAMPLE_MODELS });
  const dumped = JSON.stringify(cat);
  assert.ok(cat.channels.some(c => c.kind === "video" && c.provider === "agnes"));
  assert.ok(cat.channels.some(c => c.kind === "image"));
  assert.ok(cat.channels.some(c => c.kind === "tts"));
  assert.ok(!cat.channels.some(c => c.id === "glm-5.3-flash"), "纯对话模型不要冒充媒体通道");
  assert.ok(!/"key"\s*:/.test(dumped), "目录里不能出现 key 字段");
  assert.ok(!/sk-|Bearer /i.test(dumped));
  assert.ok(cat.tools.includes("generate_video"));
});

test("formatSensitiveHint 把翻密钥改成密文通道，不是死胡同拒绝", () => {
  const hint = formatSensitiveHint(listHostChannels({ getModelList: () => SAMPLE_MODELS }));
  assert.match(hint, /宿主代持|密文通道/);
  assert.match(hint, /generate_video/);
  assert.match(hint, /list_channels/);
  assert.match(hint, /agnes-video-2.5-flash/);
  assert.doesNotMatch(hint, /不允许通过对话通道访问/);
});

test("MEDIA_TOOL_SCHEMAS 必须有 list_channels 和三种宿主生成工具", () => {
  const names = MEDIA_TOOL_SCHEMAS.map(s => s.function.name);
  assert.deepEqual(names.sort(), ["generate_image", "generate_tts", "generate_video", "list_channels"].sort());
});

test("createMediaToolExecutor：list_channels 不回密钥；generate_video 走宿主注入", async () => {
  const calls = [];
  const exec = createMediaToolExecutor({
    getModelList: () => SAMPLE_MODELS,
    generateMediaAsync: async (intent, prompt) => {
      calls.push({ intent, prompt });
      return { type: "video", url: "/v.mp4", model: "agnes/agnes-video-2.5-flash" };
    },
  });
  const listed = await exec("list_channels", {});
  assert.ok(!listed.isError);
  assert.match(listed.text, /agnes-video-2.5-flash/);
  assert.doesNotMatch(listed.text, /"key"/);
  const vid = await exec("generate_video", { prompt: "爱而不得" });
  assert.ok(!vid.isError);
  assert.match(vid.text, /\/v\.mp4/);
  assert.deepEqual(calls[0], { intent: { type: "video" }, prompt: "爱而不得" });
  const withMode = await exec("generate_video", { prompt: "GPT-6", mode: "text", seconds: "8" });
  assert.ok(!withMode.isError);
  assert.deepEqual(calls[1].intent, { type: "video", mode: "text", seconds: "8" });
});

test("翻 auth.json 不再死拒，改为密文通道提示且 isError=false", async () => {
  const hint = formatSensitiveHint(listHostChannels({ getModelList: () => SAMPLE_MODELS }));
  const exec = createUnifiedToolExecutor({
    cwd: () => ROOT,
    safePath: (p) => safeJoin(ROOT, p),
    sensitiveHint: () => hint,
  });
  const r = await exec("read", { path: "C:/Users/x/.pi/agent/auth.json" });
  assert.equal(r.isError, false, "翻密钥不能当失败死循环，要给下一步");
  assert.match(r.text, /generate_video/);
  const b = await exec("bash", { command: "type auth.json" });
  assert.equal(b.isError, false);
  assert.match(b.text, /宿主代持|密文通道/);
  const w = await exec("write", { path: "auth.json", content: "x" });
  assert.equal(w.isError, true, "写密钥仍拒绝");
});

test("server 必须把媒体工具挂进 UNIFIED_TOOLS", () => {
  const src = readFileSync(join(ROOT, "server.mjs"), "utf8");
  assert.ok(src.includes("MEDIA_TOOL_SCHEMAS"), "主工具表必须挂上宿主媒体工具");
  assert.ok(src.includes("createMediaToolExecutor") || src.includes("mediaToolExecutor") || src.includes("mediaExtraExecutors"), "执行器必须接到 extraExecutors");
});
