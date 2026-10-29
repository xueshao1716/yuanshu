// 工具包运行时：权限、越界、超时、正常返回（2026-10-29）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runToolpackTool, toolDefsFromPack } from "../../engine/toolpack-runtime.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "tp-"));
const tool = (body, name = "demo") => ({ name, description: "演示", body });

test("纯计算工具能跑并返回字符串", async () => {
  const r = await runToolpackTool({ tool: tool("return '你好 ' + args.name"), args: { name: "世界" }, wsRoot: ws() });
  assert.equal(r.ok, true);
  assert.equal(r.text, "你好 世界");
});

test("返回对象会序列化", async () => {
  const r = await runToolpackTool({ tool: tool("return { a: 1 }"), wsRoot: ws() });
  assert.equal(r.ok, true);
  assert.match(r.text, /"a":1/);
});

test("没有声明 net 就调 http_get 会被拒", async () => {
  const r = await runToolpackTool({ tool: tool("return await $tools.http_get({ url: 'https://example.com' })"), wsRoot: ws(), permissions: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /权限不足|net/);
});

test("声明 net 后能用宿主 fetch（用假实现，不出网）", async () => {
  const fake = async () => ({ status: 200, text: async () => "页面内容" });
  const r = await runToolpackTool({
    tool: tool("const r = await $tools.http_get({ url: 'https://example.com' }); return r.status + ':' + r.text"),
    wsRoot: ws(), permissions: ["net"], fetchImpl: fake,
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, "200:页面内容");
});

test("read_text 只能读工作区内", async () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "a.txt"), "hello", "utf8");
  const ok = await runToolpackTool({ tool: tool("return await $tools.read_text({ path: 'a.txt' })"), wsRoot: root, permissions: ["fs"] });
  assert.equal(ok.text, "hello");
  const bad = await runToolpackTool({ tool: tool("return await $tools.read_text({ path: '../../secret.txt' })"), wsRoot: root, permissions: ["fs"] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /越界/);
});

test("write_text 需要 fs 权限，且会建目录", async () => {
  const root = ws();
  const noPerm = await runToolpackTool({ tool: tool("return await $tools.write_text({ path: 'x.txt', text: '1' })"), wsRoot: root });
  assert.equal(noPerm.ok, false);
  const ok = await runToolpackTool({ tool: tool("const r = await $tools.write_text({ path: 'deep/x.txt', text: 'hi' }); return r.ok"), wsRoot: root, permissions: ["fs"] });
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "deep", "x.txt"), "utf8"), "hi");
});

test("无限循环会超时而不是拖死服务", async () => {
  const r = await runToolpackTool({ tool: tool("while (true) {}"), wsRoot: ws(), timeoutMs: 800 });
  assert.equal(r.ok, false);
  assert.match(r.error, /超时|退出/);
});

test("工具体里用 require 会报错（没有模块系统）", async () => {
  const r = await runToolpackTool({ tool: tool("const fs = require('fs'); return 'x'"), wsRoot: ws() });
  assert.equal(r.ok, false);
  assert.match(r.error, /require is not defined/);
});

test("toolDefsFromPack 名字带前缀且不超长", () => {
  const defs = toolDefsFromPack({ id: "my-pack", name: "我的包", tools: [{ name: "do_thing", description: "做事", parameters: { type: "object", properties: {} } }] });
  assert.equal(defs.length, 1);
  assert.equal(defs[0].function.name, "tp_my_pack_do_thing");
  assert.match(defs[0].function.description, /我的包/);
});
