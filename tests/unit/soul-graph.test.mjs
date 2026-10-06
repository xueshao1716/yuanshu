import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSoulGraph, readMemoryFiles, summarizeMemoryText } from "../../engine/soul-graph.mjs";

test("纠正记忆取「- 纠正:」内容，新的在前；其它文件取标题", () => {
  const fix = summarizeMemoryText("### a\n- 纠正: 旧的\n### b\n- 纠正: **新的** `x`\n### c\n- 纠正: 旧的\n", "记忆/纠正记忆.md");
  assert.deepEqual(fix, { count: 3, items: ["旧的", "新的 x"] });
  const log = summarizeMemoryText("# 标题\n## 第一\n正文\n### 第二\n#### 太深\n", "记忆/记忆日志.md");
  assert.deepEqual(log, { count: 1, items: ["第一"] });
  assert.deepEqual(summarizeMemoryText("### 甲\n### 乙\n", "x.md"), { count: 2, items: ["甲", "乙"] });
});

test("readMemoryFiles：缺的文件标出来，不抛", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-"));
  fs.mkdirSync(path.join(root, "记忆"));
  fs.writeFileSync(path.join(root, "记忆.md"), "## 约定\n## 项目\n");
  const files = readMemoryFiles(root);
  assert.equal(files[0].count, 2);
  assert.equal(files[0].label, "固定记忆");
  assert.ok(files.slice(1).every((f) => f.missing));
});

test("buildSoulGraph：核心 → 五个枢纽 → 叶子，跨枢纽连线只连存在的节点", () => {
  const g = buildSoulGraph({
    persona: { name: "小语", age: 20, values: ["直说"], tone: ["直接"] },
    genome: { genes: { learning: { baseline: 0.6, expression: 0.75, mutability: 0.1 }, caution: { baseline: 0.4, expression: 0.4 } }, proposals: [{ status: "pending" }] },
    emotion: { primary: "calm", valence: 0.6, arousal: 0.4 },
    memory: [{ rel: "记忆/纠正记忆.md", label: "纠正", en: "Corrections", count: 3, items: ["x"] }],
    skills: [{ name: "a", category: "creative" }, { name: "b", category: "creative" }, { name: "c", category: "data" }],
    knowledge: { summary: { counts: { committed: 5, blocked: 1 } } },
    learning: [{ title: "早", at: "2026-01-01" }, { title: "晚", at: "2026-02-01" }],
    now: Date.parse("2026-10-06T00:00:00Z"),
  });
  const hubs = g.nodes.filter((n) => n.kind === "hub").map((n) => n.id);
  assert.deepEqual(hubs, ["genes", "emotion", "memory", "skills", "learning"]);
  assert.equal(g.nodes.filter((n) => n.kind === "core").length, 1);
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.equal(byId["gene:learning"].metric, "75%");
  assert.equal(byId["genes"].detail.facts.find((f) => f[0] === "待审提案")[1], "1");
  assert.equal(byId["skill:creative"].metric, "2");
  assert.deepEqual(byId["learning"].detail.items, ["晚", "早"]);
  assert.ok(g.nodes.every((n) => n.kind !== "leaf" || (n.value >= 0 && n.value <= 1)));
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.ok(g.links.every((l) => ids.has(l.a) && ids.has(l.b)));
  const cross = g.links.filter((l) => l.kind === "cross").map((l) => `${l.a}>${l.b}`);
  assert.ok(cross.includes("gene:learning>learning"));
  assert.ok(cross.includes("gene:caution>mem:记忆/纠正记忆.md"));
  assert.ok(!cross.some((c) => c.startsWith("gene:curiosity"))); // 没这个基因就不连
});

test("空输入也能出一张最小的图", () => {
  const g = buildSoulGraph({});
  assert.equal(g.nodes[0].label, "小语");
  assert.equal(g.nodes.filter((n) => n.kind === "hub").length, 5);
});
