// 工具包进对话工具表 + 备份裁剪 的回归测试（2026-10-30）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPlugin, setSetting, listBackups, pruneBackups } from "../../engine/plugin-store.mjs";
import { syncToolpacks, toolpacksInChat, setToolpacksInChat } from "../../engine/toolpack-chat.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "tpc-"));
const pack = (id) => ({
  id, name: "工具包", version: "1.0.0", type: "toolpack", permissions: ["net"],
  payload: { tools: [{ name: "say_hi", description: "打招呼", body: "return 'hi ' + (args.name || '')", parameters: { type: "object", properties: {} } }] },
});
const baseTools = () => [{ type: "function", function: { name: "bash", description: "跑命令", parameters: { type: "object", properties: {} } } }];

test("默认关闭：不往工具表里加东西", () => {
  const root = ws();
  installPlugin(root, pack("p1"));
  const tools = baseTools(), executors = {};
  const out = syncToolpacks({ wsRoot: root, tools, executors });
  assert.equal(out.enabled, false);
  assert.equal(tools.length, 1);
  assert.equal(Object.keys(executors).length, 0);
});

test("打开后挂上 tp_ 前缀的工具，执行器能跑通", async () => {
  const root = ws();
  installPlugin(root, pack("p1"));
  setToolpacksInChat(root, true);
  const tools = baseTools(), executors = {};
  const out = syncToolpacks({ wsRoot: root, tools, executors });
  assert.equal(out.enabled, true);
  assert.equal(out.tools, 1);
  const name = tools.find((t) => t.function.name.startsWith("tp_")).function.name;
  assert.equal(name, "tp_p1_say_hi");
  const r = await executors[name]({ name: "世界" });
  assert.equal(r.text, "hi 世界");
});

test("关掉后把工具和执行器都摘掉", () => {
  const root = ws();
  installPlugin(root, pack("p1"));
  setToolpacksInChat(root, true);
  const tools = baseTools(), executors = {};
  syncToolpacks({ wsRoot: root, tools, executors });
  assert.equal(tools.length, 2);
  setToolpacksInChat(root, false);
  const out = syncToolpacks({ wsRoot: root, tools, executors });
  assert.equal(out.enabled, false);
  assert.equal(tools.length, 1, "只剩 bash");
  assert.equal(Object.keys(executors).length, 0);
});

test("停用的工具包不会被挂上", () => {
  const root = ws();
  installPlugin(root, pack("p1"));
  setSetting(root, "allowToolpacksInChat", true);
  const st = JSON.parse(fs.readFileSync(path.join(root, "记忆", "运行时", "插件.json"), "utf8"));
  st.enabled.p1 = false;
  fs.writeFileSync(path.join(root, "记忆", "运行时", "插件.json"), JSON.stringify(st), "utf8");
  const tools = baseTools(), executors = {};
  const out = syncToolpacks({ wsRoot: root, tools, executors });
  assert.equal(out.tools, 0);
  assert.equal(tools.length, 1);
});

test("卸载后工具消失（不留悬空执行器）", () => {
  const root = ws();
  installPlugin(root, pack("p1"));
  setToolpacksInChat(root, true);
  const tools = baseTools(), executors = {};
  syncToolpacks({ wsRoot: root, tools, executors });
  assert.ok(Object.keys(executors).length > 0);
  fs.rmSync(path.join(root, "插件", "p1"), { recursive: true, force: true });
  syncToolpacks({ wsRoot: root, tools, executors });
  assert.equal(tools.length, 1);
});

test("备份只留最近 3 份，裁剪可指定", () => {
  const root = ws();
  const mk = (v) => ({ id: "bp", name: "备份", version: v, type: "skill", payload: { "SKILL.md": "# x" } });
  for (const v of ["1.0.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0"]) installPlugin(root, mk(v));
  assert.ok(listBackups(root, "bp").length <= 3, "安装时自动裁到 3");
  const before = listBackups(root, "bp").length;
  pruneBackups(root, "bp", { keep: 1 });
  assert.equal(listBackups(root, "bp").length, 1);
  assert.ok(before >= 1);
});

test("toolpacksInChat 默认 false", () => {
  assert.equal(toolpacksInChat(ws()), false);
});
