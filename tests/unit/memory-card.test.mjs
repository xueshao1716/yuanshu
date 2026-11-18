// 卡片层契约（2026-11-13）：事实背后要留得住原话。
// 覆盖：写入时 card 落库（用户原话在前 + 会话/时间/消息 id）/ 超长按 CARD_MAX 截断且保留头部 /
//       召回只给 200 字片段、提示词不塞卡片 / 按 id 取全文 / 旧库无列自动 ALTER /
//       autostore 沉淀时把这一轮用户原话写进卡片。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const db = await import("../../engine/memory/db.mjs");
const recallMod = await import("../../engine/memory/recall.mjs");

function tmpRoot(prefix = "ys-card-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 起一个干净库：记忆库是惰性单例，换工作区必须先 reset，否则会复用上一条连接。 */
function freshDb() {
  const root = tmpRoot();
  db.resetMemoryDb();
  db.initMemoryDb(root);
  return root;
}

// ---------------------------------------------------------------------------
// 1. 写入
// ---------------------------------------------------------------------------

test("写入时 card 落库：用户原话在前，会话/时间/消息 id 一起存", () => {
  freshDb();
  const card = db.buildCardText({
    user: "以后界面都用深色，别再给我浅色了",
    assistant: "好，深色科技风，记住了。",
  });
  const item = db.addMemory({
    memory_type: "preference", summary: "偏好深色界面", source: "auto",
    card_text: card, card_session: "sess-42", card_at: 1700000000000, card_msg_id: "msg-9",
  });
  assert.match(item.card_text, /^【用户】以后界面都用深色/, "用户原话必须在最前面");
  assert.match(item.card_text, /【助手】好，深色科技风/, "必要助手片段也要留");
  assert.equal(item.card_session, "sess-42");
  assert.equal(item.card_at, 1700000000000);
  assert.equal(item.card_msg_id, "msg-9");
});

test("卡片超长：按 CARD_MAX 截断且保留头部（用户原话优先，助手段让位）", () => {
  const user = "原话开头" + "甲".repeat(900);
  const card = db.buildCardText({ user, assistant: "助手回应".repeat(50) });
  assert.equal(card.length, db.CARD_MAX, "超长要截到 CARD_MAX");
  assert.ok(card.startsWith("【用户】原话开头"), "截断只砍尾部，头部（用户原话）必须留");
  assert.equal(card.at(-1), "…");
  assert.ok(!card.includes("【助手】"), "用户原话就把额度用完了，助手片段不该挤掉原话");
});

test("没给卡片就不编：card_* 全为 null，库不会凭空变大", () => {
  freshDb();
  const item = db.addMemory({ memory_type: "fact", summary: "一条没有出处的记忆", source: "auto" });
  assert.equal(item.card_text, null);
  assert.equal(item.card_session, null);
  assert.equal(item.card_at, null);
  assert.equal(item.card_msg_id, null);
});

// ---------------------------------------------------------------------------
// 2. 读取：召回只给片段，全文按 id 取
// ---------------------------------------------------------------------------

test("召回带 card 片段（≤200 字）；提示词只注入摘要，不塞卡片", async () => {
  freshDb();
  const full = "【用户】" + "很长很长的原话".repeat(100);
  const item = db.addMemory({ memory_type: "fact", summary: "部署机用 8787 端口", source: "auto", card_text: full });

  // 2026-11-15：召回改为异步（混合检索要对 query 调一次 embedding；未注入 embedding → 自动退回旧公式）
  const r = await recallMod.recallMemories({ query: "部署机 8787 端口", limit: 5, touch: false });
  assert.equal(r.items.length, 1);
  assert.ok(r.items[0].card, "召回结果要带 card");
  assert.ok(r.items[0].card.length <= db.CARD_PREVIEW, `片段不能超过 200 字：${r.items[0].card.length}`);
  assert.ok(r.items[0].card.endsWith("…"), "截断要有省略号");
  assert.ok(r.items[0].card !== full, "召回默认不给全文");

  const prompt = await recallMod.recallPrompt({ query: "部署机 8787 端口" });
  assert.ok(prompt.includes("部署机用 8787 端口"), "摘要照旧进提示词");
  assert.ok(!prompt.includes("【用户】"), "提示词注入不塞卡片，避免上下文被撑爆");

  // 全文按 id 取
  const card = db.getMemoryCard(item.memory_id);
  assert.equal(card.card_text.length, db.CARD_MAX);
  assert.ok(card.card_text.startsWith("【用户】很长很长的原话"));
});

// ---------------------------------------------------------------------------
// 3. 旧库兼容
// ---------------------------------------------------------------------------

test("旧库没有卡片/归档列：打开时自动 ALTER，读写都不炸", () => {
  const root = tmpRoot("ys-card-legacy-");
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  const legacy = new DatabaseSync(path.join(root, "memory", "memory.db"));
  legacy.exec(`CREATE TABLE memories (
    memory_id TEXT PRIMARY KEY, user_id TEXT, memory_type TEXT, summary TEXT,
    raw_content TEXT, vector_id TEXT, created_at INTEGER, updated_at INTEGER,
    importance_score REAL, expire_at INTEGER, source TEXT, access_count INTEGER,
    last_accessed_at INTEGER, status TEXT, last_confirmed_at INTEGER
  )`);
  legacy.prepare("INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "old-1", "owner", "fact", "旧库原有记忆", null, null, 1, 1, 0.5, null, "manual", 0, null, "active", 1,
  );
  legacy.close();

  db.resetMemoryDb();
  db.initMemoryDb(root);
  const old = db.getMemory("old-1");
  assert.equal(old.summary, "旧库原有记忆", "旧数据必须还在");
  assert.equal(old.card_text, null);
  const fresh = db.addMemory({ memory_type: "fact", summary: "补列之后写入", source: "auto", card_text: "【用户】补列之后也要能存" });
  assert.equal(fresh.card_text, "【用户】补列之后也要能存");
  assert.equal(db.getMemoryCard("old-1").card_text, null, "旧行没有卡片，按 id 取也不炸");

  const conn = new DatabaseSync(path.join(root, "memory", "memory.db"), { readOnly: true });
  const cols = conn.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
  conn.close();
  for (const c of ["card_text", "card_session", "card_at", "card_msg_id", "archived_at", "archive_reason", "restored_at"]) {
    assert.ok(cols.includes(c), `旧库没有自动补上列：${c}`);
  }
});

// ---------------------------------------------------------------------------
// 4. 写入路径（autostore）
// ---------------------------------------------------------------------------

test("autostore 沉淀时写入卡片：这一轮用户原话 + 助手回应 + 会话/时间", async () => {
  const H = await import("../../engine/memory/autostore.mjs");
  const dir = tmpRoot("ys-card-auto-");
  const ingested = [];
  H.initMemoryAutoStore({
    wsRoot: () => dir,
    ingest: async (body) => { ingested.push(body); return { item: { memory_id: "m-auto" }, vector_id: "v1" }; },
    recall: async () => [],
    chat: async () => ({ text: JSON.stringify({ store: true, memory_type: "preference", summary: "偏好深色界面", importance_score: 0.8 }) }),
    getModel: () => ({ provider: "t", id: "m" }),
  });
  H.settleTurnMemory({
    sessionId: "sess-card",
    user: "以后界面一律深色，别再给我浅色的了",
    assistant: "好，以后界面一律深色科技风，霓虹渐变点缀，这条约定我会跨会话保留，不再切回浅色主题，后面所有交付都按深色执行。",
    executionIdentity: "owner",
  });
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(ingested.length, 1, "该沉淀一轮");
  assert.match(ingested[0].card_text, /^【用户】以后界面一律深色/, "卡片必须以用户原话开头");
  assert.match(ingested[0].card_text, /【助手】好，以后界面一律深色科技风/, "必要的助手片段也要带上");
  assert.equal(ingested[0].card_session, "sess-card");
  assert.ok(ingested[0].card_at > 0, "要记下这段话发生的时间");
});

// ---------------------------------------------------------------------------
// 5. 接线（server.mjs 无法在单测里 import：静态断言守住出口）
// ---------------------------------------------------------------------------

test("接线（静态断言）：召回带片段、列表只给片段、全文有 /card 只读接口", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const src = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
  assert.ok(src.includes("card: memoryDb.cardPreview(r.card_text)"), "向量召回路径要带 card 片段");
  assert.ok(src.includes("card: memoryDb.cardPreview(card_text)"), "GET /api/memory 列表要给片段、不给全文");
  assert.ok(src.includes("/^\\/api\\/memory\\/([^/]+)\\/card$/"), "要有按 id 取完整卡片的只读接口");
  assert.ok(src.includes("memoryDb.getMemoryCard(m[1])"), "/card 接口要真的走 getMemoryCard");
});
