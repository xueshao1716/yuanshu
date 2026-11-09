import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRegistry } from "../../engine/plugin-registry.mjs";
import { isCorePlugin } from "../../engine/engine-panel.mjs";
import {
  SEAM_PROMPT,
  mergeContributedSections,
  collectPromptContributions,
  registerPromptSection,
  assembleYuanshuSystem,
  promptTimeText,
  promptPersonaText,
} from "../../engine/yuanshu-seams.mjs";
import { assemblePrompt } from "../../engine/yuanshu-prompt.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("mergeContributedSections：默认追加，replace 才整段换", () => {
  const base = { skills: "技能A", protocol: "协议" };
  const appended = mergeContributedSections(base, [
    { section: "skills", text: "技能B" },
    { section: "time", text: "此刻" },
  ]);
  assert.equal(appended.protocol, "协议");
  assert.match(appended.skills, /技能A/);
  assert.match(appended.skills, /技能B/);
  assert.equal(appended.time, "此刻");
  const replaced = mergeContributedSections(base, [
    { section: "skills", text: "只要B", replace: true },
  ]);
  assert.equal(replaced.skills, "只要B");
});

test("collectPromptContributions：按注册序从 registry 收区段", async () => {
  const reg = new PluginRegistry();
  await registerPromptSection(reg, {
    id: "yuanshu:prompt:time",
    section: "time",
    contribute: () => "时间块",
  });
  await registerPromptSection(reg, {
    id: "extra:skills",
    section: "skills",
    contribute: () => "外挂技能",
  });
  const got = collectPromptContributions(reg, {});
  assert.equal(got[0].section, "time");
  assert.equal(got[0].text, "时间块");
  assert.equal(got[1].text, "外挂技能");
  assert.equal(got[0].seam, SEAM_PROMPT);
});

test("assembleYuanshuSystem：宿主协议 + 插件时间/身份", async () => {
  const reg = new PluginRegistry();
  await registerPromptSection(reg, {
    id: "yuanshu:prompt:time",
    section: "time",
    contribute: (ctx) => promptTimeText(ctx.now),
  });
  await registerPromptSection(reg, {
    id: "yuanshu:prompt:persona",
    section: "persona",
    contribute: (ctx) => promptPersonaText(ctx.model),
  });
  const now = new Date(2026, 8, 7, 15, 44);
  const blob = assemblePrompt(assembleYuanshuSystem(
    { message: "嗯" },
    reg,
    { now, model: { provider: "deepseek", id: "v4-flash" } },
  ));
  assert.match(blob, /section:protocol/);
  assert.match(blob, /section:time/);
  assert.match(blob, /2026-09-07/);
  assert.match(blob, /section:persona/);
  assert.match(blob, /deepseek/);
  assert.match(blob, /v4-flash/);
});

test("无 registry 时 assembleYuanshuSystem 用 baseOpts 兜底", () => {
  const blob = assemblePrompt(assembleYuanshuSystem({
    message: "嗯",
    persona: "兜底身份",
    time: "兜底时间",
  }, null, {}));
  assert.match(blob, /兜底身份/);
  assert.match(blob, /兜底时间/);
});

test("yuanshu: 接缝是核心锁定，网页卸不掉", () => {
  assert.equal(isCorePlugin("yuanshu:prompt:time"), true);
  assert.equal(isCorePlugin("echo-demo"), false);
});

test("主聊天开轮必须收接缝，不能中途热替换循环", () => {
  const src = readFileSync(join(ROOT, "engine", "unified-chat.mjs"), "utf8");
  const start = src.indexOf("export async function handleUnifiedChat");
  // 2026-11-09：窗口从 12000 放宽到 20000——GRN 接线后 assembleYuanshuSystem 的偏移
  // 从 11888 挪到 12258，原窗口正好卡在边界；断言意图（开轮从接缝拼 system）不变。
  const fn = src.slice(start, start + 20000);
  assert.ok(fn.includes("assembleYuanshuSystem"), "开轮要从接缝拼 system");
  assert.ok(fn.includes("collectPromptContributions") || fn.includes("assembleYuanshuSystem"), "必须读 registry");
  const init = src.slice(src.indexOf("export async function initEngine"), src.indexOf("export async function initEngine") + 8000);
  assert.ok(init.includes("yuanshu:prompt:time"), "时间区段必须是锁定插件");
  assert.ok(init.includes("yuanshu:prompt:persona"), "身份区段必须是锁定插件");
});
