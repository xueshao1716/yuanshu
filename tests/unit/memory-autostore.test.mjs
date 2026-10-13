// memory-autostore 契约：门槛四件套 + 判断解析 + 去重（2026-10-13）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const H = await import("../../engine/memory-autostore.mjs");

function makeDeps({ chatReply, recallHits = [], model = { provider: "t", id: "m" } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-auto-"));
  const ingested = [];
  const deps = {
    wsRoot: () => dir,
    ingest: async (body) => { ingested.push(body); return { item: { memory_id: "m_" + ingested.length, ...body }, vector_id: body.vector_id ?? "v1" }; },
    recall: async () => recallHits,
    chat: async () => ({ text: chatReply }),
    getModel: () => model,
  };
  return { deps, dir, ingested };
}
const flush = (ms = 250) => new Promise(r => setTimeout(r, ms));

test("值得沉淀：judge 通过 → ingest 双写 + 状态记录", async () => {
  const { deps, dir, ingested } = makeDeps({ chatReply: '{"store":true,"memory_type":"preference","summary":"伙伴要深色界面","importance_score":0.8}' });
  H.initMemoryAutoStore(deps);
  H.settleTurnMemory({ sessionId: "s1", user: "界面要深色", assistant: "好的已记住，以后产品展示页一律深色科技风，霓虹渐变点缀，加上科技感细节背景，这个约定我会一直遵守，后续所有交付都按这个执行。", executionIdentity: "owner-id" });
  await flush();
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].memory_type, "preference");
  const st = JSON.parse(fs.readFileSync(path.join(dir, "memory", "autostore-state.json"), "utf8"));
  assert.equal(st.sessions.s1.lastVerdict, "stored");
});

test("无 executionIdentity（陌生/子任务）不沉淀", async () => {
  const { deps, ingested } = makeDeps({ chatReply: '{"store":true,"memory_type":"fact","summary":"x","importance_score":0.5}' });
  H.initMemoryAutoStore(deps);
  H.settleTurnMemory({ sessionId: "s2", user: "hi", assistant: "这是一段足够长的回复内容，超过最低门槛四十个字符以上，用来验证门槛逻辑是否生效。", executionIdentity: null });
  await flush();
  assert.equal(ingested.length, 0);
});

test("judge 说 store:false → 不写入但记冷却", async () => {
  const { deps, ingested } = makeDeps({ chatReply: '{"store":false}' });
  H.initMemoryAutoStore(deps);
  H.settleTurnMemory({ sessionId: "s3", user: "在吗", assistant: "在的，有什么需要我帮忙的尽管说，我随时待命处理你的任务和问题。", executionIdentity: "id" });
  await flush();
  assert.equal(ingested.length, 0);
});

test("冷却期内同会话第二轮跳过（60s 冷却）", async () => {
  const reply = '{"store":true,"memory_type":"fact","summary":"条目","importance_score":0.5}';
  const { deps, ingested } = makeDeps({ chatReply: reply });
  H.initMemoryAutoStore(deps);
  const body = { user: "q", assistant: "一段足够长的回复内容超过四十个字符门槛，用来验证冷却逻辑生效与否，多写几个字保险。", executionIdentity: "id" };
  H.settleTurnMemory({ sessionId: "s4", ...body });
  await flush();
  H.settleTurnMemory({ sessionId: "s4", ...body });
  await flush();
  assert.equal(ingested.length, 1, "冷却期第二轮不重复写入");
});

test("语义去重：相似 ≥0.92 跳过", async () => {
  const { deps, ingested } = makeDeps({
    chatReply: '{"store":true,"memory_type":"fact","summary":"已记过的内容","importance_score":0.5}',
    recallHits: [{ memory_id: "old", summary: "已记过的内容", similarity: 0.95 }],
  });
  H.initMemoryAutoStore(deps);
  H.settleTurnMemory({ sessionId: "s5", user: "q", assistant: "一段足够长的回复内容超过四十个字符门槛，用来验证去重逻辑是否正常生效。", executionIdentity: "id" });
  await flush();
  assert.equal(ingested.length, 0, "重复记忆不入库");
});

test("stats 只读面", () => {
  const s = H.autoStoreStats();
  assert.equal(s.enabled, true);
  assert.ok(s.dailyLimit >= 1);
});

test("模块未注入时 settle 静默无操作", () => {
  H.initMemoryAutoStore(null);
  assert.doesNotThrow(() => H.settleTurnMemory({ user: "x", assistant: "y", executionIdentity: "z" }));
});
