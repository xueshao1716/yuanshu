// 记忆召回台账（ORM）+ 黄金事实：判"用上了"的边界比功能本身更容易错，逐条钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  memoryId, recallBoost, recallWeights, recordRecall, settleRecall,
  recallSummary, loadJournal, novelHits, USED_MIN_NOVEL,
} from "../../engine/recall-journal.mjs";
import { routeMemory, routeMemoryRows } from "../../engine/yuanshu-memroute.mjs";
import {
  derivedPathFacts, contactFacts, goldFacts, goldSection,
  loadGoldFile, writeGoldFacts, GOLD_FILE,
} from "../../engine/gold-facts.mjs";

function tmpWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recall-"));
  fs.mkdirSync(path.join(root, "记忆", "运行时"), { recursive: true });
  return root;
}

const JOURNAL = path.join("记忆", "运行时", "记忆召回.json");

test("memoryId：缩进/换行变化算同一条，来源不同算两条", () => {
  const a = memoryId("log", "### 1\n- 要点：面试准备了两个月");
  const b = memoryId("log", "  ### 1    - 要点：面试准备了两个月  ");
  const c = memoryId("relation", "### 1\n- 要点：面试准备了两个月");
  assert.equal(a, b, "空白差异不该改变 id，否则同一条记忆会被记成两次");
  assert.notEqual(a, c, "来源不同必须分开统计");
  assert.equal(a.length, 12);
});

test("recallBoost：用过提权、注入多次没用沉底、中间不动", () => {
  assert.equal(recallBoost({ injected: 1, used: 0 }), 0, "只注入一次没资格沉底");
  assert.equal(recallBoost({ injected: 1, used: 1 }), 2);
  assert.equal(recallBoost({ injected: 9, used: 2 }), 3, "提权封顶 +3");
  assert.equal(recallBoost({ injected: 4, used: 0 }), -3);
  assert.equal(recallBoost({ injected: 8, used: 0 }), -4);
  assert.equal(recallBoost({ injected: 40, used: 0 }), -6, "下沉封底 -6，再没用也不会无限掉");
  assert.equal(recallBoost(null), 0);
});

test("novelHits：只认记忆独有词，用户问过的词不算记忆的功劳", () => {
  const mem = "### 1\n- 要点：源码仓库在 D:\\pi-web，安装目录是 Programs\\Yuanshu";
  const q = "昨天部署到哪了";
  const reply = "源码仓库 D:\\pi-web 已经是最新，安装目录也核对过";
  const hits = novelHits(mem, reply, q);
  assert.ok(hits.length >= USED_MIN_NOVEL, `独有词不够：${hits.join(",")}`);
  assert.ok(hits.includes("pi-web"), "英文标识符要能当证据");
  // 回复只是把用户问题里的词重复一遍 → 不算记忆的功劳
  const mem2 = "系统内存占用偏高";
  assert.equal(
    novelHits(mem2, "系统内存占用偏高，可能要清理缓存", "系统内存占用偏高的原因").length,
    0,
    "问题自带的词不能算记忆被用",
  );
});

test("novelHits：日期与结构字段名不算证据（每条记忆都带日期头）", () => {
  const dated = "### 2026-09-07 15:07\n- topic: 引擎\n- status: current";
  // 回复里只出现日期头和结构字段 → 不能判成"用上了"
  assert.equal(novelHits(dated, "2026-09-07 15:07 topic current status", "随便问问").length, 0, "日期与结构字段不算证据");
  // 真出现内容词才算（引擎 只在这条记忆里）
  assert.deepEqual(novelHits(dated, "这条讲的是引擎的事", "随便问问"), ["引擎"]);
});

test("recordRecall → settleRecall：注入记账、用上记功", () => {
  const ws = tmpWs();
  const rows = [
    { id: memoryId("log", "源码仓库在 D:\\pi-web，安装目录 Programs\\Yuanshu"), source: "log", score: 3, text: "源码仓库在 D:\\pi-web，安装目录 Programs\\Yuanshu" },
    { id: memoryId("log", "系统内存 3.6 GB"), source: "log", score: 1, text: "系统内存 3.6 GB" },
  ];
  const rec = recordRecall(ws, { query: "昨天部署到哪了", rows, sessionId: "s1" });
  assert.equal(rec.recorded, true);
  assert.equal(rec.ids.length, 2);
  const afterInject = loadJournal(ws);
  assert.equal(afterInject.pending.length, 1);
  assert.equal(afterInject.stats[rows[0].id].injected, 1);

  const settled = settleRecall(ws, {
    userMsg: "昨天部署到哪了",
    assistantText: "源码仓库 D:\\pi-web 已经是最新，安装目录也核对过",
  });
  assert.equal(settled.settled, true);
  assert.equal(settled.injected, 2);
  assert.equal(settled.used, 1, "只有第一条被真用到");
  assert.equal(settled.ids[0], rows[0].id);
  assert.ok(settled.evidence[0].tokens.length >= 2, "要留下判断依据，事后能复核");

  const j = loadJournal(ws);
  assert.equal(j.pending.length, 0, "结算后必须清掉 pending，不能重复记功");
  assert.equal(j.stats[rows[0].id].used, 1);
  assert.equal(j.stats[rows[1].id].used, 0);
  assert.equal(j.recent.length, 1);
});

test("settleRecall：没回复/没待结算/查询对不上且过期 → 都不硬凑", () => {
  const ws = tmpWs();
  assert.equal(settleRecall(ws, { userMsg: "x", assistantText: "" }).settled, false, "无回复不结算");
  assert.equal(settleRecall(ws, { userMsg: "x", assistantText: "有回复" }).settled, false, "没有待结算");
  recordRecall(ws, { query: "问 A", rows: [{ id: "i1", source: "log", score: 2, text: "甲" }], at: Date.now() - 3 * 60 * 60 * 1000 });
  const out = settleRecall(ws, { userMsg: "完全不同的句子", assistantText: "甲" });
  assert.equal(out.settled, false, "超过保鲜期宁可不算，也不能张冠李戴");
  assert.equal(out.reason, "召回过期");
});

test("重复记录同一句查询：pending 不叠加，injected 不重复计数", () => {
  const ws = tmpWs();
  const rows = [{ id: "i1", source: "log", score: 2, text: "甲" }];
  recordRecall(ws, { query: "同一句", rows });
  recordRecall(ws, { query: "同一句", rows });
  const j = loadJournal(ws);
  assert.equal(j.pending.length, 1, "重试不该留两条 pending");
  assert.equal(j.stats.i1.injected, 2, "但确实注入了两次（各轮都进了提示词）");
});

test("recallWeights + routeMemoryRows：提权改变排序，沉底不隐藏仍相关的记忆", () => {
  const ws = tmpWs();
  const textA = "### 1\n- 要点：缓存命中率 99.7%";
  const textB = "### 2\n- 要点：缓存策略改了三次";
  const rows = [
    { id: memoryId("log", textA), source: "log", score: 1, text: textA },
    { id: memoryId("log", textB), source: "log", score: 1, text: textB },
  ];
  // A 被用过两次，B 注入 8 次一次没用
  recordRecall(ws, { query: "缓存", rows: [rows[0]] });
  settleRecall(ws, { userMsg: "缓存", assistantText: "缓存命中率 99.7% 了" });
  recordRecall(ws, { query: "缓存", rows: [rows[0]] });
  settleRecall(ws, { userMsg: "缓存", assistantText: "命中率 99.7% 挺好" });
  for (let i = 0; i < 8; i++) recordRecall(ws, { query: `缓存 ${i}`, rows: [rows[1]] });
  const w = recallWeights(ws);
  assert.equal(w[rows[0].id], 3);
  assert.equal(w[rows[1].id], -4);

  const cands = [{ source: "log", text: textA, id: rows[0].id }, { source: "log", text: textB, id: rows[1].id }];
  const ranked = routeMemoryRows({ query: "缓存", candidates: cands, entities: [], weights: w });
  assert.equal(ranked[0].id, rows[0].id, "被用过的要排前面");
  assert.equal(ranked[1].id, rows[1].id, "沉底只是排后，不许消失（本句两个都命中缓存）");
  assert.equal(ranked[0].boost, 3, "分数里要能看出 boost");
  // 完全无关时，沉底条目也不会因为负分被"抬"进来
  const unrelated = routeMemoryRows({ query: "面试", candidates: cands, entities: [], weights: w });
  assert.equal(unrelated.length, 0);
  // 旧接口 routeMemory 仍只返回字符串，行为不变
  const legacy = routeMemory({ query: "缓存", candidates: cands, entities: [] });
  assert.ok(legacy.every((t) => typeof t === "string"));
  assert.equal(legacy.length, 2);
});

test("recallSummary：只读汇总能看出提权/沉底条数", () => {
  const ws = tmpWs();
  recordRecall(ws, { query: "甲事", rows: [{ id: "a", source: "log", score: 2, text: "甲" }] });
  settleRecall(ws, { userMsg: "甲事", assistantText: "甲" });
  const s = recallSummary(ws);
  assert.equal(s.tracked, 1);
  assert.equal(s.injected, 1);
  // 只撞上 1 个独有词（甲），够不上 USED_MIN_NOVEL=2 → 不算被用，这正是防误判的门槛
  assert.equal(s.used, 0);
  assert.equal(s.boosted, 0);
  assert.equal(s.pending, 0);
  assert.equal(s.recent.length, 1);
});

test("gold-facts：路径事实只报存在的目录，联系方式从活文件读", () => {
  const ws = tmpWs();
  const facts = derivedPathFacts(ws);
  const ids = facts.map((f) => f.id);
  assert.ok(ids.includes("workspace"), `至少要报工作区：${JSON.stringify(facts)}`);
  for (const f of facts) {
    assert.ok(fs.existsSync(f.text) && fs.statSync(f.text).isDirectory(), `${f.id} 指向了不存在的目录：${f.text}`);
  }
  assert.equal(new Set(ids).size, ids.length, "同一 id 不许出现两次");
  // 不存在的路径绝不能被当成事实
  assert.ok(!derivedPathFacts(path.join(ws, "不存在的目录")).some((f) => f.text.includes("不存在的目录")));
  assert.deepEqual(contactFacts(ws), [], "没有联系方式文件就不要编");

  fs.writeFileSync(path.join(ws, "记忆", "运行时", "主人联系.json"), JSON.stringify({ email: "a@b.c", qq: "123" }), "utf8");
  const c = contactFacts(ws);
  assert.equal(c.length, 1);
  assert.match(c[0].text, /a@b\.c/);
  assert.match(c[0].text, /123/);
});

test("gold-facts：首次读取按实况播种，人工条目按 id 去重、有字数上限", () => {
  const ws = tmpWs();
  const first = loadGoldFile(ws);
  assert.ok(first.facts.some((f) => f.id === "workspace"), "首次要播种工作区");
  assert.ok(fs.existsSync(path.join(ws, GOLD_FILE)), "要落盘，之后可人工改");

  const wrote = writeGoldFacts(ws, [
    { id: "repo", label: "源码仓库", text: "D:\\pi-web", source: "人工" },
    { id: "note", label: "额外约定", text: "提交前先跑单测", source: "人工" },
  ]);
  assert.equal(wrote.ok, true);
  const merged = goldFacts(ws);
  const ids = merged.map((f) => f.id);
  assert.ok(ids.includes("repo"));
  assert.ok(ids.includes("note"));
  assert.ok(ids.includes("workspace"), "现读的派生事实永远在，不能被文件覆盖掉");
  assert.equal(new Set(ids).size, ids.length, "id 不许重复");

  // 上限：塞 30 条只留 8
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, label: `条${i}`, text: `内容${i}` }));
  writeGoldFacts(ws, many);
  assert.equal(loadGoldFile(ws).facts.length, 8);
});

test("结算接进了两条引擎路径：pi（turn-memory）与 元枢（memory-autostore）", async () => {
  const { settleTurnMemory: settlePi } = await import("../../engine/turn-memory.mjs");
  const { initMemoryAutoStore, settleTurnMemory: settleYuan } = await import("../../engine/memory-autostore.mjs");

  const qa = "源码仓库在哪";
  const reply = "源码仓库 D:\\pi-web 已经是最新，安装目录我也核对过";
  const row = { id: "w1", source: "log", score: 2, text: "源码仓库在 D:\\pi-web，安装目录 Programs\\Yuanshu" };

  // ── pi 路径：从会话文件里读本轮助手回复来结算 ──
  const wsPi = tmpWs();
  const file = path.join(wsPi, "s.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: reply }] } }) + "\n");
  recordRecall(wsPi, { query: qa, rows: [row] });
  await settlePi({ wsRoot: wsPi, entry: { sm: { sessionFile: file } }, message: qa, bytesBefore: 0 });
  assert.equal(loadJournal(wsPi).stats.w1.used, 1, "pi 路径没结算");

  // ── 元枢路径：settleTurnMemory 先记账，再走"要不要沉淀"的判断 ──
  const wsYuan = tmpWs();
  initMemoryAutoStore({ wsRoot: wsYuan });
  recordRecall(wsYuan, { query: qa, rows: [row] });
  settleYuan({ sessionId: "s", user: qa, assistant: reply });
  assert.equal(loadJournal(wsYuan).stats.w1.used, 1, "元枢路径没结算（即使没有判断模型，结算也应先发生）");
});

test("goldSection：带标题、有工作区、总长受控", () => {
  const ws = tmpWs();
  const s = goldSection(ws);
  assert.match(s, /黄金事实/);
  assert.match(s, /工作区/);
  assert.ok(s.length < 900, `黄金事实是每轮都带的，不能自己膨胀：${s.length}`);
  // 塞满人工条目后仍然受 MAX_CHARS 约束
  writeGoldFacts(ws, Array.from({ length: 8 }, (_, i) => ({ id: `y${i}`, label: `条${i}`, text: "长".repeat(200) })));
  const long = goldSection(ws);
  assert.ok(long.length <= 700 + 80, `超长没截断：${long.length}`);
});
