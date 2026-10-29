// 插件商店：校验/安装/启用/卸载/目录（2026-10-29）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateManifest, installPlugin, listInstalled, setEnabled,
  uninstallPlugin, readCatalog, installFromCatalog,
} from "../../engine/plugin-store.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "plugins-"));
const skill = (id) => ({
  id, name: "演示技能", version: "1.0.0", type: "skill",
  payload: { "SKILL.md": "# 演示\n\n正文" },
});

test("id 不合法直接拒（防路径穿越）", () => {
  assert.equal(validateManifest({ id: "../../etc", name: "x", version: "1.0.0", type: "skill" }).ok, false);
  assert.equal(validateManifest({ id: "Bad Upper", name: "x", version: "1.0.0", type: "skill" }).ok, false);
});

test("版本号格式要像样", () => {
  assert.match(validateManifest({ id: "ok-id", name: "x", version: "1", type: "skill" }).error, /1\.0\.0/);
});

test("技能包必须带 SKILL.md", () => {
  const r = validateManifest({ id: "no-md", name: "x", version: "1.0.0", type: "skill", payload: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /SKILL\.md/);
});

test("MCP 包必须有 command", () => {
  const r = validateManifest({ id: "mcp-x", name: "x", version: "1.0.0", type: "mcp", payload: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /command/);
});

test("安装写盘 + 记账，默认启用", () => {
  const root = ws();
  const r = installPlugin(root, skill("demo-skill"));
  assert.equal(r.ok, true);
  const dir = path.join(root, "插件", "demo-skill");
  assert.ok(fs.existsSync(path.join(dir, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(dir, "plugin.json")));
  const list = listInstalled(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].enabled, true);
  assert.equal(list[0].exists, true);
});

test("停用/启用改状态", () => {
  const root = ws();
  installPlugin(root, skill("toggle-me"));
  assert.equal(setEnabled(root, "toggle-me", false).enabled, false);
  assert.equal(listInstalled(root)[0].enabled, false);
  assert.equal(setEnabled(root, "toggle-me", true).enabled, true);
});

test("卸载删目录并清账", () => {
  const root = ws();
  installPlugin(root, skill("bye"));
  assert.equal(uninstallPlugin(root, "bye").ok, true);
  assert.equal(listInstalled(root).length, 0);
  assert.equal(fs.existsSync(path.join(root, "插件", "bye")), false);
});

test("手删目录后 exists=false（面板能看出来）", () => {
  const root = ws();
  installPlugin(root, skill("gone"));
  fs.rmSync(path.join(root, "插件", "gone"), { recursive: true, force: true });
  assert.equal(listInstalled(root)[0].exists, false);
});

test("catalog 缺文件时给能看懂的原因", () => {
  const root = ws();
  const c = readCatalog(root);
  assert.equal(c.items.length, 0);
  assert.match(c.error, /catalog\.json/);
});

test("从 catalog 安装（内嵌 payload）", () => {
  const root = ws();
  fs.mkdirSync(path.join(root, "插件"), { recursive: true });
  fs.writeFileSync(path.join(root, "插件", "catalog.json"), JSON.stringify({
    plugins: [skill("from-catalog")],
  }), "utf8");
  const cat = readCatalog(root);
  assert.equal(cat.items.length, 1);
  assert.equal(cat.items[0].installable, true);
  assert.equal(installFromCatalog(root, "from-catalog").ok, true);
  assert.equal(listInstalled(root)[0].id, "from-catalog");
});

test("catalog 里不合规的条目标记 installable=false 而不是炸掉", () => {
  const root = ws();
  fs.mkdirSync(path.join(root, "插件"), { recursive: true });
  fs.writeFileSync(path.join(root, "插件", "catalog.json"), JSON.stringify({
    plugins: [{ id: "broken", name: "坏包", version: "1.0.0", type: "skill", payload: {} }],
  }), "utf8");
  const cat = readCatalog(root);
  assert.equal(cat.items[0].installable, false);
  assert.match(cat.items[0].error, /SKILL\.md/);
  assert.equal(installFromCatalog(root, "broken").ok, false);
});
