// 引擎页「旁路插件」要真起作用（2026-11-17）：
// 以前只能挂「回声/时钟」两个空壳，挂上对主聊天毫无影响。现在网页能写提示词插件：
// 选好进哪一段（记忆/技能/计划）、可设触发词，挂上后下一句主聊天就带上；落盘，重启还在。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRegistry } from "../../engine/plugin-registry.mjs";
import { collectPromptContributions } from "../../engine/yuanshu-seams.mjs";
import {
  PROMPT_PLUGINS_REL,
  normalizePromptPlugin,
  readPromptPlugins,
  savePromptPlugin,
  removePromptPlugin,
  promptPluginDef,
  loadPromptPlugins,
} from "../../engine/prompt-plugins.mjs";
import { isCorePlugin, decorateEngineStatus } from "../../engine/engine-panel.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "prompt-plugins-"));

test("校验：名称/段落/内容必填，段落只认 memory/skills/plan，触发词可用逗号写", () => {
  const p = normalizePromptPlugin({ name: "  报销规矩 ", section: "memory", text: "报销走钉钉审批", triggers: "报销， 发票,  ,发票" });
  assert.equal(p.name, "报销规矩");
  assert.equal(p.section, "memory");
  assert.deepEqual(p.triggers, ["报销", "发票"]);
  assert.match(p.id, /^user-prompt:/);
  assert.equal(isCorePlugin(p.id), false, "用户插件可以卸");
  assert.throws(() => normalizePromptPlugin({ name: "", section: "memory", text: "x" }), /名称/);
  assert.throws(() => normalizePromptPlugin({ name: "a", section: "persona", text: "x" }), /段落/);
  assert.throws(() => normalizePromptPlugin({ name: "a", section: "memory", text: "   " }), /内容/);
  assert.throws(() => normalizePromptPlugin({ name: "a", section: "memory", text: "x".repeat(4001) }), /内容/);
  assert.throws(() => normalizePromptPlugin({ name: "a", section: "memory", text: "x", mount: "hack" }), /mount/);
});

test("挂进注册表后真进主聊天的提示词贡献；有触发词时只在命中那句生效", async () => {
  const reg = new PluginRegistry();
  const always = normalizePromptPlugin({ name: "回复风格", section: "skills", text: "回答先给结论" });
  const gated = normalizePromptPlugin({ name: "报销规矩", section: "memory", text: "报销走钉钉审批", triggers: ["报销"] });
  await reg.load(promptPluginDef(always));
  await reg.load(promptPluginDef(gated));
  const hit = collectPromptContributions(reg, { message: "这个月报销怎么走" });
  assert.deepEqual(hit.map(c => [c.section, c.text]), [["skills", "回答先给结论"], ["memory", "报销走钉钉审批"]]);
  const miss = collectPromptContributions(reg, { message: "今天天气" });
  assert.deepEqual(miss.map(c => c.text), ["回答先给结论"]);
  await reg.unregister(gated.id);
  assert.deepEqual(collectPromptContributions(reg, { message: "报销" }).map(c => c.text), ["回答先给结论"]);
});

test("落盘：保存/删除写进 记忆/运行时，重启后 loadPromptPlugins 全部挂回", async () => {
  const ws = tmp();
  try {
    const a = savePromptPlugin(ws, { name: "A", section: "plan", text: "先列计划" });
    savePromptPlugin(ws, { name: "B", section: "memory", text: "常用目录 D:/work" });
    assert.ok(existsSync(join(ws, PROMPT_PLUGINS_REL)));
    assert.equal(readPromptPlugins(ws).length, 2);
    assert.throws(() => savePromptPlugin(ws, { name: "A", section: "memory", text: "重名" }), /重名|已有/);
    assert.equal(removePromptPlugin(ws, a.id), true);
    assert.equal(removePromptPlugin(ws, a.id), false);
    const reg = new PluginRegistry();
    assert.equal(await loadPromptPlugins(reg, ws), 1);
    assert.deepEqual(collectPromptContributions(reg, {}).map(c => c.text), ["常用目录 D:/work"]);
    // 坏文件不能拖垮引擎启动
    rmSync(join(ws, PROMPT_PLUGINS_REL));
    assert.deepEqual(readPromptPlugins(ws), []);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("状态接口给用户插件带上段落/触发词/内容，面板才能显示它在干什么", () => {
  const p = normalizePromptPlugin({ name: "报销规矩", section: "memory", text: "报销走钉钉审批", triggers: ["报销"] });
  const out = decorateEngineStatus({ plugins: [{ id: p.id, name: p.name, mounted: true }] }, { userPlugins: [p] });
  assert.equal(out.plugins[0].core, false);
  assert.equal(out.plugins[0].section, "memory");
  assert.deepEqual(out.plugins[0].triggers, ["报销"]);
  assert.equal(out.plugins[0].text, "报销走钉钉审批");
  assert.doesNotMatch(String(out.note), /演示/, "已经真生效，不能再说是演示");
});

test("主聊天引擎初始化要把落盘的提示词插件挂回去", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "..", "engine", "unified-chat.mjs"), "utf8");
  assert.match(src, /loadPromptPlugins\(nextGateway\.registry/);
});
