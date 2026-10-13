// MemorySkill 工具契约：四动作 + 降级分支 + 孤儿防护（2026-10-13）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiMemoryTool, MEMORY_TOOL_SCHEMA } from "../../engine/memory-tool.mjs";
import { createMemoryDbTestHarness } from "./helpers/memory-harness.mjs";

const Type = { Unsafe: (p) => p };
const parse = (r) => JSON.parse(r.content[0].text);

test("memory 工具 schema 与动作集", () => {
  assert.equal(MEMORY_TOOL_SCHEMA.function.name, "memory");
  const { action } = MEMORY_TOOL_SCHEMA.function.parameters.properties;
  assert.deepEqual([...action.enum].sort(), ["forget", "forget_by_query", "recall", "remember", "stats", "update"]);
});

test("remember → recall(FTS降级) → forget_by_query 全链路 + 无孤儿向量", async () => {
  const h = await createMemoryDbTestHarness();
  try {
    const tool = createPiMemoryTool(Type, { db: h.db, vectors: h.vectors, embedding: h.embedding });
    const r1 = parse(await tool.execute("t", { action: "remember", user_id: "u1", memory_type: "preference", summary: "伙伴喜欢深色界面", importance_score: 0.8 }));
    assert.ok(r1.remembered, "remember 返回 memory_id");
    const r2 = parse(await tool.execute("t", { action: "recall", user_id: "u1", query: "深色界面" }));
    assert.ok(r2.results.length >= 1, "FTS 降级分支能按关键词回查");
    const r3 = parse(await tool.execute("t", { action: "forget_by_query", user_id: "u1", query: "深色界面" }));
    assert.equal(r3.forgotten, 1);
    assert.equal(await h.vectorsLeft(), 0, "遗忘后向量零孤儿");
  } finally { h.close(); }
});

test("user_id 隔离 + 非法动作拒绝", async () => {
  const h = await createMemoryDbTestHarness();
  try {
    const tool = createPiMemoryTool(Type, { db: h.db, vectors: h.vectors, embedding: h.embedding });
    await tool.execute("t", { action: "remember", user_id: "a", memory_type: "fact", summary: "甲的记忆" });
    const r = parse(await tool.execute("t", { action: "recall", user_id: "b", query: "甲" }));
    assert.equal(r.results.length, 0, "b 看不到 a 的记忆");
    const bad = await tool.execute("t", { action: "no_such_action" });
    assert.equal(bad.isError, true);
  } finally { h.close(); }
});
