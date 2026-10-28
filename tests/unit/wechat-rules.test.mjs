// 规矩从文件读：默认兜底 / 文件优先 / 缓存 / 改文件即生效（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWechatRules, seedWechatRules, DEFAULT_RULES, RULES_REL } from "../../engine/wechat-rules.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "wxrules-"));

test("没有文件 → 用内置默认", () => {
  const root = ws();
  const r = loadWechatRules(root);
  assert.equal(r.source, "builtin");
  assert.match(r.text, /微信环境/);
});

test("seed 写出文件，之后按文件读", () => {
  const root = ws();
  const s = seedWechatRules(root);
  assert.equal(s.ok, true);
  assert.ok(fs.existsSync(path.join(root, RULES_REL)));
  const r = loadWechatRules(root);
  assert.equal(r.source, "file");
  assert.match(r.text, /web_search/);
});

test("seed 不覆盖用户已经改过的文件", () => {
  const root = ws();
  seedWechatRules(root);
  const file = path.join(root, RULES_REL);
  fs.writeFileSync(file, "自定义规矩：只回一句话。", "utf8");
  const again = seedWechatRules(root);
  assert.equal(again.existed, true);
  assert.equal(fs.readFileSync(file, "utf8"), "自定义规矩：只回一句话。");
});

test("改了文件立刻生效（按 mtime 刷新缓存）", async () => {
  const root = ws();
  seedWechatRules(root);
  const file = path.join(root, RULES_REL);
  assert.match(loadWechatRules(root).text, /微信环境/);
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(file, "新规矩：先给结论，再给细节。", "utf8");
  assert.match(loadWechatRules(root).text, /先给结论/);
});

test("文件是空的 → 回落默认（不变成哑巴）", () => {
  const root = ws();
  const file = path.join(root, RULES_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "   \n\n", "utf8");
  const r = loadWechatRules(root);
  assert.equal(r.source, "builtin");
  assert.equal(r.text, DEFAULT_RULES);
});
