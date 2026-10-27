// 源文档变了 → 标出要人复核的 Wiki 页（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWiki, WIKI_DIR } from "../../engine/memory-wiki.mjs";
import { markStaleForPaths, clearStaleForGenerated, staleSummary, staleWikiLine, sourcesOfPage, readStale } from "../../engine/wiki-stale.mjs";

function ws() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wikistale-"));
  fs.mkdirSync(path.join(root, "文档"), { recursive: true });
  fs.mkdirSync(path.join(root, "记忆", "知识", "entries"), { recursive: true });
  return root;
}

test("能从页面里读出「来源」列表", () => {
  const src = sourcesOfPage("# x\n\n- 类型：经验\n- 来源：文档/需求.md、记忆.md\n");
  assert.deepEqual(src, ["文档/需求.md", "记忆.md"]);
  assert.deepEqual(sourcesOfPage("没有来源行"), []);
});

test("来源文档变了 → 对应页面被标为待复核", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "记忆.md"), "# 记忆\n\n## 约定\n- 交付前先跑 output_check\n", "utf8");
  buildWiki({ wsRoot: root });

  // 改成手写版（删标记、留来源）再标脏——自动页本来就会被重建刷新，不该进提示
  const pagePath = path.join(root, WIKI_DIR, "约定.md");
  fs.writeFileSync(pagePath, "# 约定\n\n- 来源：记忆.md\n\n手写补充\n", "utf8");

  const r = markStaleForPaths({ wsRoot: root, paths: ["记忆.md"] });
  assert.ok(r.marked.includes("约定"), JSON.stringify(r));

  const s = staleSummary(root);
  assert.equal(s.count, 1);
  assert.equal(s.pages[0].topic, "约定");
  assert.match(staleWikiLine(root), /Wiki 待复核/);
});

test("无关文档变动不会误标", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "记忆.md"), "# 记忆\n\n## 约定\n- x\n", "utf8");
  buildWiki({ wsRoot: root });
  const r = markStaleForPaths({ wsRoot: root, paths: ["文档/完全无关.md"] });
  assert.deepEqual(r.marked, []);
  assert.equal(staleSummary(root).count, 0);
});

test("重建能刷新的自动页 → 标记清掉；手写页的标记留着", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "记忆.md"), "# 记忆\n\n## 自动页\n- 内容\n", "utf8");
  buildWiki({ wsRoot: root });
  markStaleForPaths({ wsRoot: root, paths: ["记忆.md"] });
  assert.equal(staleSummary(root).count, 1);

  // 自动页：重建时被重写 → 清标记
  const cleared = clearStaleForGenerated({ wsRoot: root, topics: ["自动页"] });
  assert.equal(cleared.cleared, 1);

  // 手写页：删掉标记再标脏，重建不该清
  const p = path.join(root, WIKI_DIR, "自动页.md");
  // 真实做法：只删标记，保留「来源」行
  fs.writeFileSync(p, "# 自动页\n\n- 来源：记忆.md\n\n我自己改的\n", "utf8");
  markStaleForPaths({ wsRoot: root, paths: ["记忆.md"] });
  const after = clearStaleForGenerated({ wsRoot: root, topics: ["自动页"] });
  assert.equal(after.cleared, 0, "手写页的标记不能被自动清掉");
  assert.equal(staleSummary(root).count, 1);
});

test("同一页重复标脏只记一次（不刷屏）", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "记忆.md"), "# m\n\n## 甲\n- y\n", "utf8");
  buildWiki({ wsRoot: root });
  markStaleForPaths({ wsRoot: root, paths: ["记忆.md"] });
  const second = markStaleForPaths({ wsRoot: root, paths: ["记忆.md"] });
  assert.deepEqual(second.marked, []);
  assert.equal(second.already, 1);
  assert.equal(Object.keys(readStale(root).pages).length, 1);
});

test("没有待复核时，环境事实那一行为空", () => {
  const root = ws();
  assert.equal(staleWikiLine(root), "");
});
