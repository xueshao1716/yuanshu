import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReceiptBlock, syncPluginReceipt, MARK_BEGIN, MARK_END } from "../../engine/plugin-receipt.mjs";

const agent = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "recv-")), "agent");
const plugins = [
  { id: "webpage-to-markdown", name: "网页转 Markdown", type: "skill", description: "网页正文转干净 markdown", enabled: true },
  { id: "mcp-fetch", name: "MCP：网页抓取", type: "mcp", enabled: true },
];

test("块内容：技能/MCP 分类 + 名字", () => {
  const b = buildReceiptBlock(plugins);
  assert.ok(b.includes(MARK_BEGIN) && b.includes(MARK_END));
  assert.match(b, /技能：网页转 Markdown/);
  assert.match(b, /MCP 服务：MCP：网页抓取/);
});

test("没有插件就不产生块", () => {
  assert.equal(buildReceiptBlock([]), "");
  assert.equal(buildReceiptBlock([{ id: "x", name: "x", enabled: false }]), "");
});

test("同步：首次追加，第二次幂等", () => {
  const dir = agent();
  const a = syncPluginReceipt({ agentDir: dir, installed: plugins });
  assert.equal(a.ok, true); assert.equal(a.changed, true);
  const b = syncPluginReceipt({ agentDir: dir, installed: plugins });
  assert.equal(b.changed, false);
  const out = fs.readFileSync(path.join(dir, "APPEND_SYSTEM.md"), "utf8");
  assert.equal((out.match(new RegExp(MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
});

test("同步：卸载后块被摘掉，其他内容保留", () => {
  const dir = agent();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "APPEND_SYSTEM.md");
  fs.writeFileSync(file, "<!-- persona:begin -->\n人格\n<!-- persona:end -->\n", "utf8");
  syncPluginReceipt({ agentDir: dir, installed: plugins });
  syncPluginReceipt({ agentDir: dir, installed: [] });
  const out = fs.readFileSync(file, "utf8");
  assert.ok(!out.includes(MARK_BEGIN));
  assert.match(out, /人格/);
});

test("同步：新装一个 → 块里多一条", () => {
  const dir = agent();
  syncPluginReceipt({ agentDir: dir, installed: [plugins[0]] });
  syncPluginReceipt({ agentDir: dir, installed: plugins });
  const out = fs.readFileSync(path.join(dir, "APPEND_SYSTEM.md"), "utf8");
  assert.match(out, /网页转 Markdown/);
  assert.match(out, /MCP 服务/);
});
