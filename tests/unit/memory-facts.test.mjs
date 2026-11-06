// 记忆现行事实：同 topic 只留一条 current，旧条作废，召回默认看不见
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertMemoryFact, factKey } from "../../engine/memory/facts.mjs";
import { searchMemoryLog, loadRecentMemory } from "../../engine/memory.mjs";
import { scanMemoryHealth } from "../../engine/memory/gardener.mjs";

function ws() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-facts-"));
  fs.mkdirSync(path.join(root, "记忆"), { recursive: true });
  fs.writeFileSync(path.join(root, "记忆.md"), "# 固定记忆\n\n## Codex 桌面版\n- 旧说明\n\n## 模型\n- 默认某模型\n");
  fs.writeFileSync(path.join(root, "记忆", "记忆日志.md"), "");
  return root;
}

test("factKey 章节为主，细键拼在后面", () => {
  assert.equal(factKey("Codex 桌面版", "codex.wire_api"), "Codex 桌面版 / codex.wire_api");
  assert.equal(factKey("Codex 桌面版", ""), "Codex 桌面版");
});

test("upsert 同 topic 只留一行现行，旧日志作废", () => {
  const root = ws();
  const a = upsertMemoryFact(root, { section: "Codex 桌面版", topic: "codex.wire_api", text: "chat", reason: "早先探测" });
  assert.equal(a.ok, true);
  const b = upsertMemoryFact(root, { section: "Codex 桌面版", topic: "codex.wire_api", text: "responses", reason: "今晚探测" });
  assert.equal(b.ok, true);

  const fixed = fs.readFileSync(path.join(root, "记忆.md"), "utf8");
  assert.equal((fixed.match(/\*\*codex\.wire_api\*\*/g) || []).length, 1);
  assert.match(fixed, /\*\*codex\.wire_api\*\*：responses/);
  assert.ok(!fixed.includes("**codex.wire_api**：chat"));

  const log = fs.readFileSync(path.join(root, "记忆", "记忆日志.md"), "utf8");
  assert.ok(log.includes("status: superseded"));
  assert.ok(log.includes("status: current"));
  assert.ok((log.match(/status: current/g) || []).length === 1);

  const rec = searchMemoryLog(root, "wire_api", 5);
  assert.ok(rec.some((x) => x.includes("responses")));
  assert.ok(!rec.some((x) => /status:\s*superseded/.test(x)));
  assert.ok(!rec.some((x) => x.includes("要点：chat")));

  const all = searchMemoryLog(root, "wire_api", 5, { includeSuperseded: true });
  assert.ok(all.some((x) => /status:\s*superseded/.test(x)));

  const recent = loadRecentMemory(root, 5);
  assert.ok(recent.every((x) => !/status:\s*superseded/.test(x)));
  fs.rmSync(root, { recursive: true, force: true });
});

test("不同 topic 互不覆盖", () => {
  const root = ws();
  upsertMemoryFact(root, { section: "Codex 桌面版", topic: "codex.wire_api", text: "responses" });
  upsertMemoryFact(root, { section: "Codex 桌面版", topic: "codex.app_version", text: "26.901" });
  const fixed = fs.readFileSync(path.join(root, "记忆.md"), "utf8");
  assert.match(fixed, /\*\*codex\.wire_api\*\*：responses/);
  assert.match(fixed, /\*\*codex\.app_version\*\*：26\.901/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("缺 section 或 text 不写盘", () => {
  const root = ws();
  const r = upsertMemoryFact(root, { topic: "codex.wire_api", text: "x" });
  assert.equal(r.ok, false);
  const log = fs.readFileSync(path.join(root, "记忆", "记忆日志.md"), "utf8");
  assert.equal(log.trim(), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("园丁能扫出同一 topic 两条 current", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "记忆", "记忆日志.md"), [
    "### 2026-09-05 10:00",
    "- topic: Codex 桌面版 / codex.wire_api",
    "- status: current",
    "- 要点：chat",
    "### 2026-09-06 15:56",
    "- topic: Codex 桌面版 / codex.wire_api",
    "- status: current",
    "- 要点：responses",
    "",
  ].join("\n"));
  const r = scanMemoryHealth(root);
  assert.ok((r.contradictions || []).length >= 1);
  assert.ok(r.contradictions.some((c) => c.topic.includes("codex.wire_api") && c.count >= 2));
  assert.ok(r.recommendations.some((x) => x.includes("对撞") || x.includes("现行")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("searchMemoryLog 按工作区隔离索引，不能复用另一个工作区的缓存", () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "mem-index-a-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "mem-index-b-"));
  try {
    for (const [root, text] of [[first, "alpha-only"], [second, "beta-only"]]) {
      const file = path.join(root, "记忆", "记忆日志.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `### 2026-09-09\n- 要点：${text}\n`);
      fs.utimesSync(file, new Date("2026-09-09T00:00:00Z"), new Date("2026-09-09T00:00:00Z"));
    }
    const a = searchMemoryLog(first, "alpha-only", 5);
    const b = searchMemoryLog(second, "beta-only", 5);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.match(b[0], /beta-only/);
    assert.doesNotMatch(b[0], /alpha-only/);
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});
