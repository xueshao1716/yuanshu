// ===== tests/unit/memory-embedding-recall.test.mjs —— 混合检索（2026-11-15）=====
//
// 契约：
//   ① 旧库自动补向量层（独立表 memory_vectors），幂等；
//   ② 有查询向量 + 行向量 → 混合分；任缺一 → 完全退回旧公式（fail-open）；
//   ③ embedding 抛错 → 整体降级，不抛错；
//   ④ 余弦手算正确、阈值生效；
//   ⑤ enabled:false → 连 embedding 都不调，逐位回旧行为；
//   ⑥ 回填脚本：dry-run 不写库、apply 分批且失败不中断、rebuild 先 staging 后整体切换；
//   ⑦ debug 对照返回新旧两套排序 + scoreParts。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbMod = () => import("../../engine/memory/db.mjs");
const recallMod = () => import("../../engine/memory/recall.mjs");
const backfillMod = () => import("../../scripts/memory-embed-backfill.mjs");

const TEST_MODEL = "test-embedding-model";

function tmpRoot(prefix = "ys-emb-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  return dir;
}

async function freshDb(t, prefix) {
  const root = tmpRoot(prefix);
  const db = await dbMod();
  const recall = await recallMod();
  db.resetMemoryDb();
  recall.resetRecallConfigCache();
  db.initMemoryDb(root);
  t.after(() => {
    try { db.resetMemoryDb(); } catch { }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { }
  });
  return { root, db, recall };
}

/** 假 embedding：记录调用次数/文本，可注入失败或逐次钩子。零网络。 */
function fakeEmbed(vec, { throwOn = null, onCall = null } = {}) {
  const fn = async (text) => {
    fn.calls.push(text);
    if (onCall) await onCall(text, fn.calls.length);
    if (throwOn && throwOn(text, fn.calls.length)) throw new Error("fake embedding 不可用");
    return typeof vec === "function" ? vec(text) : vec;
  };
  fn.calls = [];
  return fn;
}

const cfg = (model = TEST_MODEL) => () => ({ configured: true, model });
const round3 = (n) => Number(Number(n).toFixed(3));

// 旧库的 memories 表结构（2026-11-13 之前的列；无卡片/归档列、无向量层）
function makeLegacyDb(root) {
  const conn = new DatabaseSync(path.join(root, "memory", "memory.db"));
  conn.exec(`CREATE TABLE memories (
    memory_id TEXT PRIMARY KEY, user_id TEXT, memory_type TEXT, summary TEXT,
    raw_content TEXT, vector_id TEXT, created_at INTEGER, updated_at INTEGER,
    importance_score REAL, expire_at INTEGER, source TEXT, access_count INTEGER,
    last_accessed_at INTEGER, status TEXT, last_confirmed_at INTEGER
  )`);
  conn.prepare("INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("old-1", "owner", "fact", "旧库原有记忆", null, null, 1, 1, 0.5, null, "manual", 0, null, "active", 1);
  conn.close();
}

// ---------------------------------------------------------------------------
// 1. 存储层：旧库自动补向量表、幂等、归一化存储
// ---------------------------------------------------------------------------
test("旧库自动补向量层（独立表方案）：建表幂等，读写不炸", async (t) => {
  const root = tmpRoot("ys-emb-legacy-");
  makeLegacyDb(root);
  const db = await dbMod();
  t.after(() => { try { db.resetMemoryDb(); } catch { } try { fs.rmSync(root, { recursive: true, force: true }); } catch { } });
  db.resetMemoryDb();
  db.initMemoryDb(root);

  // 旧行的记忆还在，且向量层可直接写（旧库没有这张表，openDb 时自动建）
  assert.equal(db.getMemory("old-1").summary, "旧库原有记忆");
  const saved = db.setMemoryVector("old-1", { model: TEST_MODEL, vec: [3, 4] });
  assert.equal(saved.dim, 2);
  const got = db.getMemoryVector("old-1", TEST_MODEL);
  assert.ok(got, "写完必须能读回");
  assert.ok(Math.abs(got.vec[0] - 0.6) < 1e-6 && Math.abs(got.vec[1] - 0.8) < 1e-6, "存储前必须 L2 归一化");

  // 幂等：重置连接再打开一次不炸，数据还在
  db.resetMemoryDb();
  db.initMemoryDb(root);
  assert.equal(db.memoryVectorStats({ model: TEST_MODEL }).withVec, 1);
  // 同 (memory_id, model) 覆盖写不新增行
  db.setMemoryVector("old-1", { model: TEST_MODEL, vec: [1, 0] });
  assert.equal(db.memoryVectorStats({ model: TEST_MODEL }).models[0].count, 1);

  const conn = new DatabaseSync(path.join(root, "memory", "memory.db"), { readOnly: true });
  const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  conn.close();
  assert.ok(tables.includes("memory_vectors"), "旧库必须自动建出 memory_vectors");
});

test("按模型统计缺向量：joined 计数不受孤儿行影响", async (t) => {
  const { db } = await freshDb(t, "ys-emb-stats-");
  const a = db.addMemory({ memory_type: "fact", summary: "有向量的记忆", source: "auto" });
  db.addMemory({ memory_type: "fact", summary: "没向量的记忆", source: "auto" });
  db.setMemoryVector(a.memory_id, { model: "m1", vec: [1, 0] });
  db.setMemoryVector(a.memory_id, { model: "m2", vec: [0, 1] });
  const s1 = db.memoryVectorStats({ model: "m1" });
  assert.equal(s1.total, 2);
  assert.equal(s1.withVec, 1);
  assert.equal(s1.missing, 1);
  assert.equal(s1.models.length, 2, "两套模型的向量必须并存（换模型重建用）");
  // 硬删记忆时向量一起删，不留孤儿
  db.deleteMemory(a.memory_id);
  assert.equal(db.memoryVectorStats({ model: "m1" }).models.length, 0);
});

// ---------------------------------------------------------------------------
// 2. 打分：混合分 / fail-open / 阈值 / 余弦
// ---------------------------------------------------------------------------
test("有向量走混合分：语义相近压过纯关键词命中，且 query 只 embedding 一次", async (t) => {
  const { db, recall } = await freshDb(t, "ys-emb-hybrid-");
  const now = Date.now();
  // A：关键词命中（rel=0.75），但语义无关（cos=0）
  const a = db.addMemory({ memory_type: "preference", summary: "我喜欢暗色主题的界面", importance_score: 0.2, source: "manual" });
  // B：字面无命中，但语义完全对上（cos=1）、重要性更高
  const b = db.addMemory({ memory_type: "preference", summary: "用户偏好深色科技风展示页", importance_score: 0.5, source: "manual" });
  db.setMemoryVector(a.memory_id, { model: TEST_MODEL, vec: [0, 1] });
  db.setMemoryVector(b.memory_id, { model: TEST_MODEL, vec: [1, 0] });

  const embed = fakeEmbed([1, 0]);
  const out = await recall.recallMemories({ query: "暗色主题", limit: 5, touch: false, debug: true, embed, model: TEST_MODEL, now });
  assert.equal(embed.calls.length, 1, "query 只能调用一次 embedding（绝不逐行调）");
  assert.equal(out.mode, "hybrid");
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].id, b.memory_id, "语义相近的 B 必须排第一");
  assert.ok(out.items[0].scoreParts.vec > 0.35, `B 的 vec 贡献应接近 0.40：${JSON.stringify(out.items[0].scoreParts)}`);
  const aItem = out.items.find(x => x.id === a.memory_id);
  assert.equal(aItem.scoreParts.vec, 0, "cos=0 低于阈值 → vec 不加分（但仍凭关键词进来）");
  assert.ok(aItem.scoreParts.kw > 0, "A 仍有关键词贡献");
  assert.equal(aItem.mode, "hybrid");
  assert.ok(out.items[0].score > aItem.score);
});

test("无向量行完全退回旧公式（同输入同输出），debug 默认不带 scoreParts", async (t) => {
  const { db, recall } = await freshDb(t, "ys-emb-fallback-");
  const now = Date.now();
  db.addMemory({ memory_type: "preference", summary: "我喜欢暗色主题", importance_score: 0.7, source: "manual" });
  db.addMemory({ memory_type: "fact", summary: "我住在兰州，家里有只猫", importance_score: 0.6, source: "manual" });
  const rows = db.listAllMemoryRows({ status: "" });
  const embed = fakeEmbed([1, 0]);

  const out = await recall.recallMemories({ query: "暗色主题", limit: 5, touch: false, embed, model: TEST_MODEL, now });
  assert.equal(out.mode, "keyword", "库里没有同模型向量 → 整体关键字模式");
  assert.equal(embed.calls.length, 1, "降级时也只调一次 query embedding");
  for (const it of out.items) {
    const row = rows.find(r => r.memory_id === it.id);
    assert.equal(it.score, round3(recall.scoreMemory(row, "暗色主题", now)), "必须与旧公式逐位一致");
  }
  assert.equal(out.items[0].scoreParts, undefined, "普通召回不返回内部调试字段");
  // 旧签名同步调用也要保持原样（老测试依赖）
  const s1 = recall.scoreMemory(rows[0], "暗色主题", now);
  assert.equal(typeof s1, "number");
});

test("embedding 抛错 → 整体降级不报错，结果与旧公式一致", async (t) => {
  const { db, recall } = await freshDb(t, "ys-emb-throw-");
  const now = Date.now();
  db.addMemory({ memory_type: "preference", summary: "我喜欢暗色主题", importance_score: 0.8, source: "manual" });
  const rows = db.listAllMemoryRows({ status: "" });
  const embed = fakeEmbed([1, 0], { throwOn: () => true });

  const out = await recall.recallMemories({ query: "暗色主题", limit: 5, touch: false, debug: true, embed, model: TEST_MODEL, now });
  assert.equal(out.mode, "keyword");
  assert.equal(out.embed.ok, false);
  assert.match(out.embed.error, /fake embedding 不可用/);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].score, round3(recall.scoreMemory(rows[0], "暗色主题", now)));
  assert.equal(out.items[0].scoreParts.vec, null);
});

test("余弦手算正确（含 0 模长/维度不符）", async () => {
  const { cosine } = await recallMod();
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 2], [2, 4]) - 1) < 1e-12, "同向 → 1");
  assert.ok(Math.abs(cosine([1, 0], [1, 1]) - Math.SQRT1_2) < 1e-12, "45° → √2/2");
  assert.equal(cosine([0, 0], [1, 1]), 0, "0 向量不能算 NaN");
  assert.equal(cosine([1, 0, 0], [1, 0]), 0, "维度不一致 → 0");
  assert.equal(cosine(null, [1]), 0);
});

test("阈值生效：cos 低于 vecThreshold 不加分、高于才加", async () => {
  const { scoreDetailed, DEFAULT_WEIGHTS } = await recallMod();
  const now = Date.now();
  const row = { summary: "无关文本", importance_score: 1, last_accessed_at: now };
  const rowVec = [0.4, Math.sqrt(1 - 0.16)]; // 与 [1,0] 的 cos = 0.4
  const q = [1, 0];
  const base = { queryVec: q, rowVec, weights: DEFAULT_WEIGHTS };
  const hot = scoreDetailed(row, "zzz", now, { ...base, vecThreshold: 0.45 });
  assert.equal(hot.parts.vec, 0, "0.4 < 0.45 → vec 0");
  assert.equal(round3(hot.score), 0.2, "只剩 imp 0.15 + fresh 0.05");
  const loose = scoreDetailed(row, "zzz", now, { ...base, vecThreshold: 0.35 });
  assert.ok(loose.parts.vec > 0.15 && loose.parts.vec < 0.17, "0.4 * 0.40 = 0.16");
  assert.ok(loose.score > hot.score);
});

// ---------------------------------------------------------------------------
// 3. 配置：
// ---------------------------------------------------------------------------
test("配置：enabled:false 一键回旧行为（一次 embedding 都不调）", async (t) => {
  const { root, db, recall } = await freshDb(t, "ys-emb-disabled-");
  db.addMemory({ memory_type: "preference", summary: "我喜欢暗色主题", importance_score: 0.7, source: "manual" });
  fs.writeFileSync(path.join(root, "memory", "recall-weights.json"), JSON.stringify({ enabled: false }), "utf8");
  recall.resetRecallConfigCache();
  const rows = db.listAllMemoryRows({ status: "" });
  const embed = fakeEmbed([1, 0]);
  const now = Date.now();
  const out = await recall.recallMemories({ query: "暗色主题", touch: false, embed, model: TEST_MODEL, now });
  assert.equal(embed.calls.length, 0, "enabled:false 不能发 embedding 请求");
  assert.equal(out.mode, "keyword");
  assert.equal(out.config.enabled, false);
  assert.equal(out.items[0].score, round3(recall.scoreMemory(rows[0], "暗色主题", now)));
});

test("配置：权重归一化、阈值夹取、坏文件回默认", async (t) => {
  const { root, recall } = await freshDb(t, "ys-emb-cfg-");
  const file = path.join(root, "memory", "recall-weights.json");
  fs.writeFileSync(file, JSON.stringify({ weights: { kw: 2, vec: 2 }, vecThreshold: 2 }), "utf8");
  recall.resetRecallConfigCache();
  let cfg = recall.loadRecallConfig({ force: true });
  assert.ok(Math.abs(cfg.weights.kw + cfg.weights.vec + cfg.weights.imp + cfg.weights.fresh - 1) < 1e-9, "权重必须归一化到 1");
  assert.equal(cfg.vecThreshold, 1, "阈值夹到 [0,1]");
  assert.equal(cfg.embedTimeoutMs, recall.DEFAULT_EMBED_TIMEOUT_MS, "缺省 embedding 超时保护");
  fs.writeFileSync(file, "{ 坏 JSON", "utf8");
  recall.resetRecallConfigCache();
  cfg = recall.loadRecallConfig({ force: true });
  assert.deepEqual(cfg.weights, { ...recall.DEFAULT_WEIGHTS });
  assert.equal(cfg.vecThreshold, recall.DEFAULT_VEC_THRESHOLD);
  assert.equal(cfg.source, "default");
});

// ---------------------------------------------------------------------------
// 4. 回填脚本
// ---------------------------------------------------------------------------
test("回填 dry-run：只统计，不写库、不调 embedding", async (t) => {
  const { db } = await freshDb(t, "ys-emb-backfill-dry-");
  for (let i = 0; i < 3; i += 1) db.addMemory({ memory_type: "fact", summary: `记忆 ${i}`, source: "auto" });
  const { runBackfill } = await backfillMod();
  const embed = fakeEmbed([1, 0]);
  const r = await runBackfill({ mode: "dry-run", embed, configInfoFn: cfg() });
  assert.equal(r.dryRun, true);
  assert.equal(r.total, 3);
  assert.equal(r.wouldCall, 3);
  assert.equal(r.candidates, 3);
  assert.equal(r.embedded, undefined, "dry-run 不能有写入计数");
  assert.equal(embed.calls.length, 0, "dry-run 不能调 embedding");
  assert.equal(db.memoryVectorStats().models.length, 0, "dry-run 不能写库");
});

test("回填 apply：每批 ≤20、失败不中断，重跑只补缺的", async (t) => {
  const { db } = await freshDb(t, "ys-emb-backfill-apply-");
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(db.addMemory({ memory_type: "fact", summary: `记忆 ${i}`, source: "auto" }));
  const { runBackfill } = await backfillMod();
  const boomId = rows[7].memory_id;
  const embed = fakeEmbed([1, 0], { throwOn: (text) => text === "记忆 7" });
  const r = await runBackfill({ mode: "apply", embed, configInfoFn: cfg() });
  assert.equal(r.batchCount, 2, "25 条 / 每批 20 = 2 批");
  assert.equal(r.embedded, 24);
  assert.equal(r.failed, 1);
  assert.equal(r.ok, false);
  assert.equal(db.memoryVectorStats({ model: TEST_MODEL }).withVec, 24);
  assert.equal(db.getMemoryVector(boomId, TEST_MODEL), null, "失败行不写脏向量");

  // 重跑：只补缺的那 1 条（幂等，不重复调 API）
  const embed2 = fakeEmbed([1, 0]);
  const r2 = await runBackfill({ mode: "apply", embed: embed2, configInfoFn: cfg() });
  assert.equal(r2.candidates, 1);
  assert.equal(r2.embedded, 1);
  assert.equal(embed2.calls.length, 1);
  assert.equal(db.memoryVectorStats({ model: TEST_MODEL }).missing, 0);
});

test("回填 rebuild：先写影子模型，全部成功才整体切换（期间旧向量一直可读）", async (t) => {
  const { db } = await freshDb(t, "ys-emb-backfill-rebuild-");
  const rows = [];
  for (let i = 0; i < 4; i += 1) rows.push(db.addMemory({ memory_type: "fact", summary: `记忆 ${i}`, source: "auto" }));
  for (const row of rows) db.setMemoryVector(row.memory_id, { model: TEST_MODEL, vec: [1, 0] });

  const dbModRef = await dbMod();
  const midRun = [];
  const embed = fakeEmbed([0, 1], {
    onCall: async () => { midRun.push(dbModRef.memoryVectorStats({ model: TEST_MODEL }).withVec); },
  });
  const { runBackfill } = await backfillMod();
  const r = await runBackfill({ mode: "rebuild", embed, configInfoFn: cfg() });
  assert.equal(midRun[0], 4, "重建期间旧模型 4 条向量必须还在（没被提前清掉）");
  assert.ok(r.switched && !r.switched.skipped, `应当整体切换：${JSON.stringify(r.switched)}`);
  const stats = db.memoryVectorStats({ model: TEST_MODEL });
  assert.equal(stats.withVec, 4);
  assert.equal(stats.models.length, 1, "切换后只剩正式模型，影子模型被清掉");
  assert.ok(Math.abs(db.getMemoryVector(rows[0].memory_id, TEST_MODEL).vec[0]) < 1e-6, "必须重算成新向量");
});

test("回填 rebuild 中途失败：不切换，旧向量一条不少，影子清干净", async (t) => {
  const { db } = await freshDb(t, "ys-emb-rebuild-fail-");
  const rows = [];
  for (let i = 0; i < 2; i += 1) rows.push(db.addMemory({ memory_type: "fact", summary: `旧 ${i}`, source: "auto" }));
  for (const row of rows) db.setMemoryVector(row.memory_id, { model: TEST_MODEL, vec: [1, 0] });
  const bad = fakeEmbed([0, 1], { throwOn: (_t, n) => n === 2 });
  const { runBackfill } = await backfillMod();
  const r = await runBackfill({ mode: "rebuild", embed: bad, configInfoFn: cfg() });
  assert.equal(r.ok, false);
  assert.equal(r.switched.skipped, true);
  const stats = db.memoryVectorStats({ model: TEST_MODEL });
  assert.equal(stats.withVec, 2, "失败后旧模型向量一条都不能少");
  assert.equal(stats.models.length, 1, "影子模型必须清掉，不能留在库里");
});

test("回填 rebuild + --limit 试跑：只算不切换，旧向量保留", async (t) => {
  const { db } = await freshDb(t, "ys-emb-rebuild-limit-");
  for (let i = 0; i < 5; i += 1) {
    const m = db.addMemory({ memory_type: "fact", summary: `记忆 ${i}`, source: "auto" });
    db.setMemoryVector(m.memory_id, { model: TEST_MODEL, vec: [1, 0] });
  }
  const { runBackfill } = await backfillMod();
  const embed = fakeEmbed([0, 1]);
  const r = await runBackfill({ mode: "rebuild", limit: 2, embed, configInfoFn: cfg() });
  assert.equal(r.embedded, 2);
  assert.equal(r.switched.skipped, true);
  assert.match(r.switched.reason, /--limit/);
  assert.equal(db.memoryVectorStats({ model: TEST_MODEL }).withVec, 5, "试跑不能破坏已有覆盖");
});

// ---------------------------------------------------------------------------
// 5. 可观测：debug 对照
// ---------------------------------------------------------------------------
test("debug 对照：同一次查询返回新旧两套排序，各项带 scoreParts", async (t) => {
  const { db, recall } = await freshDb(t, "ys-emb-debug-");
  const now = Date.now();
  const a = db.addMemory({ memory_type: "preference", summary: "我喜欢暗色主题", importance_score: 0.2, source: "manual" });
  const b = db.addMemory({ memory_type: "preference", summary: "用户偏好深色科技风展示页", importance_score: 0.5, source: "manual" });
  db.setMemoryVector(a.memory_id, { model: TEST_MODEL, vec: [0, 1] });
  db.setMemoryVector(b.memory_id, { model: TEST_MODEL, vec: [1, 0] });
  const embed = fakeEmbed([1, 0]);
  const out = await recall.compareRecall({ query: "暗色主题", limit: 8, embed, model: TEST_MODEL, now });
  assert.equal(out.embedding.ok, true);
  assert.equal(out.embedding.model, TEST_MODEL);
  assert.equal(out.old.length, 2);
  assert.equal(out.new.length, 2);
  for (const it of out.old) {
    assert.equal(it.mode, "keyword");
    assert.equal(it.scoreParts.vec, null);
    for (const k of ["kw", "imp", "fresh"]) assert.equal(typeof it.scoreParts[k], "number");
  }
  for (const it of out.new) {
    assert.equal(it.mode, "hybrid");
    for (const k of ["kw", "vec", "imp", "fresh"]) assert.equal(typeof it.scoreParts[k], "number");
    assert.equal(typeof it.cos, "number");
  }
  assert.equal(out.diff.top1Changed, true, "构造数据下新旧 top1 必须不同");
  assert.equal(out.new[0].id, b.memory_id);
  assert.equal(typeof out.diff.overlap, "number");
  assert.ok(Array.isArray(out.diff.changed));
  assert.ok(out.newPrompt === "" || out.newPrompt.startsWith("- "));
});

test("生产接线 + 路由：server 注入 embedding、注册 /api/memory/recall/debug", async () => {
  const src = fs.readFileSync(new URL("../../server.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("initRecallEmbedding(memoryEmbedding.embed)"), "server 必须把 embedding 注入召回（否则永远 keyword 模式）");
  assert.ok(src.includes('"/api/memory/recall/debug"'), "debug 对照接口必须注册");
  assert.ok(src.includes("await recallMemories(") && src.includes("await recallPrompt("), "召回路径必须 await 异步混合检索");
  const dbSrc = fs.readFileSync(new URL("../../engine/memory/db.mjs", import.meta.url), "utf8");
  assert.ok(dbSrc.includes("CREATE TABLE IF NOT EXISTS memory_vectors"), "向量表必须幂等建表");
});
