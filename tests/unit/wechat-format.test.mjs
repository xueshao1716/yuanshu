// 微信排版：keep / auto / strip 三种模式（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatForWechat, autoFormat, readFormatMode, seedFormatConfig, FORMAT_REL } from "../../engine/wechat-format.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "wxfmt-"));

test("keep：表格/代码块/标题原样保留（只折叠空行）", () => {
  const src = "## 结论\n\n| 项 | 值 |\n|---|---|\n| 图 | 4 张 |\n\n```\nls -la\n```\n\n\n\n尾巴";
  const out = formatForWechat(src, "keep");
  assert.match(out, /## 结论/);
  assert.match(out, /\| 图 \| 4 张 \|/);
  assert.match(out, /```\nls -la\n```/);
  assert.ok(!/\n{3,}/.test(out), "多余空行应折叠");
});

test("auto：保代码块和表格，标题转加粗，链接带地址", () => {
  const src = "# 标题\n\n看 [文档](https://x.dev) 和 `code`\n\n```js\nconst a = 1\n```";
  const out = autoFormat(src);
  assert.match(out, /^标题$/m);
  assert.match(out, /文档（https:\/\/x\.dev）/);
  assert.match(out, /```js\nconst a = 1\n```/, "代码块必须完整");
});

test("strip：走旧的全剥", () => {
  const out = formatForWechat("## 标题\n**粗**", "strip");
  assert.ok(!out.includes("##"), "strip 模式不该留标题符号");
});

test("模式读不到 → 默认 keep", () => {
  assert.equal(readFormatMode(ws()), "keep");
});

test("seed 出来之后按文件读；非法值回落 keep", () => {
  const root = ws();
  seedFormatConfig(root, "auto");
  assert.equal(readFormatMode(root), "auto");
  fs.writeFileSync(path.join(root, FORMAT_REL), JSON.stringify({ mode: "乱写" }), "utf8");
  assert.equal(readFormatMode(root), "keep");
});
