// Wiki：把记忆/经验/知识渲染成人能读的主题页（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWiki, listWiki, readWiki, sectionsOf, topicsFromKnowledge, MARKER, WIKI_DIR } from "../../engine/memory-wiki.mjs";

function ws() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-"));
  fs.mkdirSync(path.join(root, "记忆", "知识", "entries"), { recursive: true });
  fs.mkdirSync(path.join(root, "工程", "经验库"), { recursive: true });
  return root;
}

test("记忆.md 的分节能被拆成主题；空节丢弃", () => {
  const text = "# 标题\n\n## 人格与工作方式\n- 直接、有条理\n\n## 空节\n\n## 约定\n- 交付前先跑 output_check\n";
  const secs = sectionsOf(text);
  assert.equal(secs.length, 2);
  assert.equal(secs[0].title, "人格与工作方式");
  assert.match(secs[1].lines[0], /output_check/);
});

test("知识库按 claim 类型聚合成「决定/偏好/教训/事实」，且同 key 合并计数", () => {
  const root = ws();
  const d = path.join(root, "记忆", "知识", "entries");
  fs.writeFileSync(path.join(d, "a.json"), JSON.stringify({
    id: "a", claims: [{ type: "decision", key: "decision:1", value: "以后交付都走 release-restart" }],
  }));
  fs.writeFileSync(path.join(d, "b.json"), JSON.stringify({
    id: "b", claims: [{ type: "decision", key: "decision:1", value: "以后交付都走 release-restart" }],
  }));
  const topics = topicsFromKnowledge(root);
  const dec = topics.find((t) => t.kind === "knowledge" && t.title === "决定");
  assert.ok(dec, JSON.stringify(topics.map((t) => t.title)));
  assert.match(dec.items[0].meta, /2 次/);
});

test("生成 Wiki：写入 index.md 与主题页，内容带自动标记", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "记忆.md"), "# 记忆\n\n## 约定\n- 交付前先跑 output_check\n", "utf8");
  const out = buildWiki({ wsRoot: root });
  assert.equal(out.ok, true);
  assert.ok(out.topics >= 1);
  assert.ok(fs.existsSync(path.join(root, WIKI_DIR, "index.md")));
  assert.ok(fs.existsSync(path.join(root, WIKI_DIR, "约定.md")));
  assert.match(readWiki({ wsRoot: root, topic: "约定" }).content, new RegExp(MARKER.slice(4, 20)));
});

test("人改过的页（删掉自动标记）不会被覆盖", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "记忆.md"), "# 记忆\n\n## 约定\n- v1\n", "utf8");
  buildWiki({ wsRoot: root });
  const p = path.join(root, WIKI_DIR, "约定.md");
  fs.writeFileSync(p, "# 约定\n\n我自己写的版本\n", "utf8");   // 没有标记 = 手写

  const out = buildWiki({ wsRoot: root });
  assert.ok(out.kept.includes("约定"), "手写页应被保留");
  assert.match(fs.readFileSync(p, "utf8"), /我自己写的版本/);
});

test("listWiki 列主题；非法主题名被拒（防路径穿越）", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "记忆.md"), "# m\n\n## 甲\n- x\n", "utf8");
  buildWiki({ wsRoot: root });
  const list = listWiki({ wsRoot: root });
  assert.ok(list.some((x) => x.name === "index"));
  assert.ok(list.some((x) => x.name === "甲"));

  assert.equal(readWiki({ wsRoot: root, topic: "../../etc/passwd" }).ok, false);
  assert.equal(readWiki({ wsRoot: root, topic: "不存在" }).ok, false);
});

test("经验库会生成总页，并带相关链接", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "工程", "经验库", "experience.md"),
    "# 经验\n\n## 部署要双推\n- gitee 和 origin 都要 push\n\n## 中文路径坑\n- cmd.exe 读不了中文 .cmd\n", "utf8");
  const out = buildWiki({ wsRoot: root });
  assert.ok(out.written.includes("经验库"));
  const page = readWiki({ wsRoot: root, topic: "经验库" }).content;
  assert.match(page, /\[\[/);
});
