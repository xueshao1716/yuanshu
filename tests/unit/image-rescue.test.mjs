// 图片路径救援：写了假路径时找真文件；找不到就剥掉标记（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findSimilarImage, rescueImagePaths } from "../../engine/wechat-image-rescue.mjs";

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rescue-"));
  const dir = path.join(root, "生成物", "图片", "albedo-gpt-16x9");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 4; i += 1) fs.writeFileSync(path.join(dir, `albedo-gpt-0${i}.png`), "x");
  return { root, dir };
}

test("假路径 → 按前缀+序号找到真实文件", () => {
  const { root, dir } = sandbox();
  const missing = path.join(root, "生成物", "图片", "albedo-real-16x9", "albedo-real-01.png");
  const hits = findSimilarImage(missing, { roots: [path.join(root, "生成物", "图片")] });
  assert.ok(hits.length >= 1, "应该找到 albedo-gpt-01");
  assert.match(hits[0], /albedo-gpt-01\.png$/);
  assert.ok(hits.every((h) => fs.existsSync(h)));
});

test("!图（假路径）→ 用真图替代，且文本里不留路径", () => {
  const { root } = sandbox();
  const missing = path.join(root, "生成物", "图片", "albedo-real-16x9", "albedo-real-02.png");
  const r = rescueImagePaths(`给你看\n!图（${missing}）\n好看吗`, { roots: [path.join(root, "生成物", "图片")] });
  assert.equal(r.rescued.length, 1, "应该记录一次救援");
  assert.match(r.images[0], /albedo-gpt-02\.png$/);
  assert.ok(!r.text.includes("albedo-real"), "文本里不该再出现假路径");
  assert.match(r.text, /好看吗/);
});

test("救不回来 → 剥掉标记，记进 dropped", () => {
  const { root } = sandbox();
  const missing = path.join(root, "nope", "totally-unrelated-99.png");
  const r = rescueImagePaths(`!图（${missing}）正文还在`, { roots: [path.join(root, "生成物", "图片")] });
  assert.equal(r.images.length, 0);
  assert.equal(r.dropped.length, 1);
  assert.ok(!r.text.includes(".png"), "裸路径必须剥掉");
  assert.match(r.text, /正文还在/);
});

test("真实存在的路径照常抽走，不触发救援", () => {
  const { dir } = sandbox();
  const real = path.join(dir, "albedo-gpt-03.png");
  const r = rescueImagePaths(`看图 ![图](${real}) 完`, { roots: [] });
  assert.equal(r.images[0], real);
  assert.equal(r.rescued.length, 0);
  assert.ok(!r.text.includes(".png"));
});

test("多种写法都能认（全角括号/无感叹号/繁体）", () => {
  const { dir } = sandbox();
  const real = path.join(dir, "albedo-gpt-01.png");
  for (const s of [`!图（${real}）`, `图(${real})`, `!圖（${real}）`, `![图](${real})`]) {
    const r = rescueImagePaths(s, { roots: [] });
    assert.equal(r.images.length, 1, `没认出来: ${s}`);
  }
});
