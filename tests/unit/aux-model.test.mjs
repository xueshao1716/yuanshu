// aux-model.test.mjs —— 辅助模型路由契约（2026-11-15）
//
// 覆盖：
//   ① 解析优先级：配置指定 → flash 探测 → 主模型回退
//   ② reasoning 模型被排除（id 关键字 + reasoning:true 都算）
//   ③ 超时触发 fail-open 到主模型，且只重试一次（不循环）
//   ④ 每次一行 [aux] 日志 + 一行 jsonl（记忆/运行时/辅助调用.jsonl），超 2000 行裁掉最旧
//   ⑤ enabled:false 时全部走调用点原模型（不探测、不二次调用）
//   ⑥ 被改的 2–3 个调用点确实走 callAux（静态断言）+ 可见性接口已注册
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUX_LOG_MAX_LINES,
  initAuxModel,
  resetAuxModel,
  resolveAuxModel,
  readAuxConfig,
  isReasoningModel,
  callAux,
  auxCallStats,
  auxStatus,
  readAuxCalls,
} from "../../engine/model/auxiliary.mjs";

const MAIN = { provider: "deepseek", id: "deepseek-flash", reasoning: true, cost: { input: 0.3, output: 1.2 } };
const FLASH = { provider: "agnes", id: "agnes-2.5-flash", cost: { input: 0, output: 0 } };
const LITE = { provider: "sensenova", id: "flash-lite", cost: { input: 0.1, output: 0.2 } };

function tmpWs(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ys-aux-"));
  if (config) writeConfig(dir, config);
  return dir;
}
function writeConfig(dir, raw) {
  const file = path.join(dir, "记忆", "运行时", "模型路由.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw), "utf8");
}
function logFileOf(dir) { return path.join(dir, "记忆", "运行时", "辅助调用.jsonl"); }

// ── ① 解析优先级 ─────────────────────────────────────────────
test("解析优先级：配置指定 > flash 探测 > 主模型回退", () => {
  const list = [MAIN, FLASH, LITE];

  // 配置指定（即使还有更便宜的 flash 也用配置的）
  const pinnedDir = tmpWs({ aux: { enabled: true, provider: "sensenova", model: "flash-lite" } });
  const pinned = resolveAuxModel({ wsRoot: pinnedDir, list, mainModel: MAIN });
  assert.equal(pinned.source, "config");
  assert.equal(pinned.model.id, "flash-lite");

  // 没配 → flash 探测取最便宜的（免费 agnes 胜过 0.3 的 lite）
  const autoDir = tmpWs();
  const probed = resolveAuxModel({ wsRoot: autoDir, list, mainModel: MAIN });
  assert.equal(probed.source, "probe");
  assert.equal(probed.model.id, "agnes-2.5-flash");
  assert.ok(probed.candidates.length >= 1, "探测依据要能展示候选");

  // 没有可用的 flash → 回退主模型
  const noFlash = resolveAuxModel({
    wsRoot: autoDir,
    list: [MAIN, { provider: "x", id: "big-pro", cost: { input: 5, output: 10 } }],
    mainModel: MAIN,
  });
  assert.equal(noFlash.source, "main");
  assert.equal(noFlash.model.id, "deepseek-flash");

  // 配置写的模型不在清单里 → 继续探测，并在 reason 里说清为什么
  const missingDir = tmpWs({ aux: { enabled: true, provider: "sensenova", model: "not-exist" } });
  const missing = resolveAuxModel({ wsRoot: missingDir, list, mainModel: MAIN });
  assert.equal(missing.source, "probe");
  assert.match(missing.reason, /不在可用模型清单/);
});

// ── ② reasoning 排除 ────────────────────────────────────────
test("reasoning 模型一律排除（id 关键字与 reasoning:true 都算）", () => {
  assert.equal(isReasoningModel({ id: "deepseek-r1" }), true);
  assert.equal(isReasoningModel({ id: "o3-mini" }), true);
  assert.equal(isReasoningModel({ id: "o4-mini" }), true);
  assert.equal(isReasoningModel({ id: "qwen-thinking-flash" }), true);
  assert.equal(isReasoningModel({ id: "deepseek-reasoner" }), true);
  assert.equal(isReasoningModel({ id: "glm-5.3-flash", reasoning: true }), true);
  assert.equal(isReasoningModel({ id: "agnes-2.5-flash" }), false);

  const dir = tmpWs();
  const list = [
    { provider: "deepseek", id: "deepseek-r1", cost: { input: 0, output: 0 } },
    { provider: "openai", id: "o3-mini", cost: { input: 0, output: 0 } },
    { provider: "zai", id: "glm-5.3-flash", reasoning: true, cost: { input: 0, output: 0 } },
    { provider: "x", id: "reasoner-flash" },
    { provider: "agnes", id: "agnes-3.0-flash", cost: { input: 0, output: 0 } },
  ];
  const r = resolveAuxModel({ wsRoot: dir, list, mainModel: MAIN });
  assert.equal(r.source, "probe");
  assert.equal(r.model.id, "agnes-3.0-flash", "只有非 reasoning 的 flash 可选");
  assert.ok(!r.candidates.some((c) => /r1|o3|thinking|reason/i.test(c.model)), "候选表里不能出现 reasoning");
});

// ── ③ 超时 fail-open，只重试一次 ─────────────────────────────
test("超时触发 fail-open 到主模型，且只重试一次", async () => {
  resetAuxModel();
  const dir = tmpWs();
  const calls = [];
  initAuxModel({
    getModelList: () => [MAIN, FLASH],
    getDefaultModel: () => MAIN,
    wsRoot: () => dir,
    log: () => {},
    chat: (model, messages, opts) => {
      calls.push({ model: `${model.provider}/${model.id}`, tools: opts?.tools, maxTokens: opts?.maxTokens });
      if (model.id === FLASH.id) return new Promise(() => {}); // 永不返回：只能靠 aux 自己的超时掐断
      return Promise.resolve({ text: "回退成功" });
    },
  });
  const started = Date.now();
  const r = await callAux({ kind: "t-timeout", messages: [{ role: "user", content: "判定一下" }], timeoutMs: 60, mainModel: MAIN });
  assert.equal(r.ok, true);
  assert.equal(r.failOpen, true);
  assert.equal(r.used, "main");
  assert.equal(r.model, "deepseek/deepseek-flash");
  assert.equal(r.attempts, 2);
  assert.equal(calls.length, 2, "只重试一次：辅助 1 次 + 回退 1 次");
  assert.deepEqual(calls.map((c) => c.model), ["agnes/agnes-2.5-flash", "deepseek/deepseek-flash"]);
  assert.equal(calls[0].tools, false, "辅助调用不带工具表");
  assert.match(r.error || "", /回退/);
  assert.ok(Date.now() - started < 2000, "超时必须由 aux 自己兜住（不能等上游）");
});

test("辅助与主模型都失败：最多两次、返回 ok:false、绝不循环", async () => {
  resetAuxModel();
  const dir = tmpWs();
  let n = 0;
  initAuxModel({
    getModelList: () => [MAIN, FLASH],
    getDefaultModel: () => MAIN,
    wsRoot: () => dir,
    log: () => {},
    chat: () => { n += 1; return Promise.reject(new Error("402 余额不足")); },
  });
  const r = await callAux({ messages: [{ role: "user", content: "x" }], timeoutMs: 1000, mainModel: MAIN });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 2);
  assert.equal(n, 2, "上限两次，绝不循环");
  assert.match(r.error, /402/);
});

test("没有 flash 可用（解析结果就是主模型）：不重复调用两次", async () => {
  resetAuxModel();
  const dir = tmpWs();
  let n = 0;
  initAuxModel({
    getModelList: () => [MAIN],
    getDefaultModel: () => MAIN,
    wsRoot: () => dir,
    log: () => {},
    chat: () => { n += 1; return Promise.resolve({ text: "ok" }); },
  });
  const r = await callAux({ messages: [{ role: "user", content: "x" }], timeoutMs: 500, mainModel: MAIN });
  assert.equal(r.ok, true);
  assert.equal(r.source, "main");
  assert.equal(n, 1, "aux 与 main 同一个模型时不做无意义重试");
});

test("json:true：返回不可解析时同样触发 fail-open 一次", async () => {
  resetAuxModel();
  const dir = tmpWs();
  const calls = [];
  initAuxModel({
    getModelList: () => [MAIN, FLASH],
    getDefaultModel: () => MAIN,
    wsRoot: () => dir,
    log: () => {},
    chat: (model) => {
      calls.push(model.id);
      return Promise.resolve({ text: model.id === FLASH.id ? "这不是 JSON" : '{"store":false}' });
    },
  });
  const r = await callAux({ json: true, messages: [{ role: "user", content: "x" }], timeoutMs: 500, mainModel: MAIN });
  assert.equal(r.ok, true);
  assert.equal(r.failOpen, true);
  assert.equal(r.json.store, false);
  assert.equal(calls.length, 2);
});

// ── ④ 日志与 jsonl 落盘 + 2000 行裁剪 ────────────────────────
test("每次调用落一行 [aux] 日志 + 一行 jsonl", async () => {
  resetAuxModel();
  const dir = tmpWs();
  const logs = [];
  initAuxModel({
    getModelList: () => [MAIN, FLASH],
    getDefaultModel: () => MAIN,
    wsRoot: () => dir,
    log: (line) => logs.push(line),
    chat: () => Promise.resolve({ text: "一句话摘要" }),
  });
  for (let i = 0; i < 3; i += 1) {
    const r = await callAux({ kind: "t-log", messages: [{ role: "user", content: `第 ${i} 条` }], mainModel: MAIN });
    assert.equal(r.ok, true);
  }
  const lines = fs.readFileSync(logFileOf(dir), "utf8").trim().split("\n");
  assert.equal(lines.length, 3, "一次调用一行 jsonl");
  const entry = JSON.parse(lines.at(-1));
  assert.equal(entry.kind, "t-log");
  assert.equal(entry.model, "agnes/agnes-2.5-flash");
  assert.equal(entry.ok, true);
  assert.equal(entry.source, "probe");
  assert.ok(entry.ms >= 0);
  assert.ok(entry.inTokens > 0, "要能估算输入 token");
  assert.equal(logs.length, 3, "[aux] 日志一次一行");
  assert.match(logs[0], /^\[aux\] model=agnes\/agnes-2\.5-flash ms=\d+ ok=true/);
});

test("jsonl 超过 2000 行时裁掉最旧的，只留最近 2000 行", async () => {
  resetAuxModel();
  const dir = tmpWs();
  const file = logFileOf(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seed = Array.from({ length: AUX_LOG_MAX_LINES }, (_, i) =>
    JSON.stringify({ at: new Date().toISOString(), kind: "seed", model: "x/y", ok: true, ms: 1, inTokens: 0, outTokens: 0 }));
  fs.writeFileSync(file, seed.join("\n") + "\n", "utf8");
  initAuxModel({
    getModelList: () => [MAIN, FLASH],
    getDefaultModel: () => MAIN,
    wsRoot: () => dir,
    log: () => {},
    chat: () => Promise.resolve({ text: "ok" }),
  });
  await callAux({ kind: "t-trim", messages: [{ role: "user", content: "超过就裁" }], mainModel: MAIN });
  const after = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(after.length, AUX_LOG_MAX_LINES, "最多 2000 行");
  const last = JSON.parse(after.at(-1));
  assert.equal(last.kind, "t-trim", "最新一行保留");
  const first = JSON.parse(after[0]);
  assert.equal(first.kind, "seed");
  assert.equal(JSON.parse(after[1]).kind, "seed", "被裁掉的是最旧那条 seed");
  assert.equal(after.filter((l) => l.includes('"kind":"t-trim"')).length, 1);
});

// ── ⑤ enabled:false 全走原模型 ──────────────────────────────
test("enabled:false 时全部走调用点原模型（不探测、不二次调用）", async () => {
  resetAuxModel();
  const dir = tmpWs({ aux: { enabled: false, provider: null, model: null } });
  assert.equal(readAuxConfig(dir).enabled, false);
  const calls = [];
  initAuxModel({
    getModelList: () => [MAIN, FLASH],
    getDefaultModel: () => MAIN,
    wsRoot: () => dir,
    log: () => {},
    chat: (model) => { calls.push(`${model.provider}/${model.id}`); return Promise.resolve({ text: "ok" }); },
  });
  const r = await callAux({ kind: "t-off", messages: [{ role: "user", content: "x" }], mainModel: MAIN });
  assert.equal(r.ok, true);
  assert.equal(r.enabled, false);
  assert.equal(r.source, "disabled");
  assert.equal(r.model, "deepseek/deepseek-flash");
  assert.deepEqual(calls, ["deepseek/deepseek-flash"], "只调原模型一次");
  const resolved = resolveAuxModel({ wsRoot: dir, list: [MAIN, FLASH], mainModel: MAIN });
  assert.equal(resolved.source, "disabled");
  assert.equal(resolved.model.id, "deepseek-flash");
});

test("配置文件缺失 = 默认启用自动探测（不会因配置缺失停摆）", () => {
  const dir = tmpWs();
  const cfg = readAuxConfig(dir);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.provider, null);
  assert.equal(cfg.model, null);
});

// ── ⑥ 端到端：记忆判断经 callAux 拿到裁决后照常沉淀 ──────────
test("集成：记忆判断走 callAux（探测模型）→ 裁决被 autostore 正常采用", async () => {
  resetAuxModel();
  const dir = tmpWs();
  const calls = [];
  initAuxModel({
    getModelList: () => [MAIN, FLASH],
    getDefaultModel: () => MAIN,
    wsRoot: () => dir,
    log: () => {},
    chat: (model) => {
      calls.push(model.id);
      return Promise.resolve({ text: '{"store":true,"memory_type":"preference","summary":"伙伴要深色界面","importance_score":0.8}' });
    },
  });
  const { initMemoryAutoStore, settleTurnMemory } = await import("../../engine/memory/autostore.mjs");
  const ingested = [];
  initMemoryAutoStore({
    wsRoot: () => dir,
    ingest: async (body) => { ingested.push(body); return { item: { memory_id: "m_aux" }, vector_id: "v1" }; },
    recall: async () => [],
    chat: (model, messages) => callAux({ kind: "memory-judge", messages, maxTokens: 300, timeoutMs: 5000, json: true, mainModel: model }),
    getModel: () => MAIN,
  });
  settleTurnMemory({
    sessionId: "aux-s1",
    user: "界面要深色",
    assistant: "好的已记住，以后产品展示页一律深色科技风，霓虹渐变点缀，加上科技感细节背景，这个约定我会一直遵守，后续所有交付都按这个执行。",
    executionIdentity: "owner-id",
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ingested.length, 1, "judge 通过 → 沉淀一次");
  assert.equal(ingested[0].memory_type, "preference");
  assert.equal(ingested[0].summary, "伙伴要深色界面");
  assert.deepEqual(calls, ["agnes-2.5-flash"], "判断确实走了 aux 探测出的便宜模型");
  assert.ok(auxCallStats({ wsRoot: dir }).calls >= 1, "这次判断要落进辅助调用账本");
});

// ── ⑦ 可见性接口 + 接线静态断言 ─────────────────────────────
test("auxStatus/auxCallStats：最近 N 次统计（次数/平均耗时/失败率）", async () => {
  resetAuxModel();
  const dir = tmpWs();
  initAuxModel({
    getModelList: () => [MAIN, FLASH],
    getDefaultModel: () => MAIN,
    wsRoot: () => dir,
    log: () => {},
    chat: () => Promise.reject(new Error("boom")),
  });
  for (let i = 0; i < 2; i += 1) {
    await callAux({ kind: "t-stats", messages: [{ role: "user", content: "x" }], timeoutMs: 500, mainModel: MAIN });
  }
  const stats = auxCallStats({ wsRoot: dir, limit: 20 });
  assert.equal(stats.calls, 2);
  assert.equal(stats.failed, 2);
  assert.equal(stats.failureRate, 1);
  assert.equal(stats.failOpen, 2);
  assert.ok(Number.isFinite(stats.avgMs));
  assert.equal(readAuxCalls({ wsRoot: dir, limit: 20 }).length, 2);

  const status = auxStatus({ wsRoot: dir });
  assert.equal(status.enabled, true);
  assert.equal(status.resolved.model, "agnes/agnes-2.5-flash");
  assert.equal(status.resolved.source, "probe");
  assert.ok(status.resolved.reason.length > 0, "要能说明探测依据");
  assert.ok(status.probe.rule.includes("flash"));
  assert.equal(status.recent.calls, 2);
  assert.equal(status.log.maxLines, AUX_LOG_MAX_LINES);
});

test("接线（静态断言）：记忆判断/会话摘要/输出质检走 callAux，/api/model-routing 已注册", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const server = fs.readFileSync(path.join(root, "server.mjs"), "utf8");

  // 记忆判断：必须走 callAux，且不再退回直接 unifiedChat
  const judgeStart = server.indexOf("initMemoryAutoStore({");
  assert.ok(judgeStart > 0, "initMemoryAutoStore 接线还在");
  const judgeBlock = server.slice(judgeStart, server.indexOf("getModel:", judgeStart));
  assert.ok(judgeBlock.includes("callAux("), "记忆判断必须走 callAux 辅助路由");
  assert.ok(judgeBlock.includes('kind: "memory-judge"'), "调用点要有 kind 便于对账");
  assert.ok(!/unifiedChat\(m,\s*messages/.test(judgeBlock), "不能退回直接 unifiedChat");

  // 输出质检员：接线也换成 callAux
  const inspectorStart = server.indexOf("initOutputInspector({");
  assert.ok(inspectorStart > 0, "initOutputInspector 接线还在");
  const inspectorBlock = server.slice(inspectorStart, inspectorStart + 900);
  assert.ok(inspectorBlock.includes("callAux("), "输出质检走 callAux");
  assert.ok(inspectorBlock.includes('kind: "output-inspector"'));

  // 可见性接口
  assert.ok(/API_ROUTES\.push\(\["GET", "\/api\/model-routing"/.test(server), "GET /api/model-routing 已注册");

  // 会话一句话摘要
  const recall = fs.readFileSync(path.join(root, "engine", "recall-api.mjs"), "utf8");
  assert.ok(recall.includes("callAux("), "会话摘要必须走 callAux");
  assert.ok(recall.includes('kind: "session-summary"'));
  assert.ok(!/await _chat\(model, \[\s*\{ role: "system", content: "用一句不超过 40 字/.test(recall), "不能退回直接 _chat");
});

test("探测：同服务商同系列同价时新版本优先（不靠写死的型号）", () => {
  const OLD = { provider: "agnes", id: "agnes-2.5-flash", cost: { input: 0, output: 0 } };
  const NEW = { provider: "agnes", id: "agnes-3.0-flash", cost: { input: 0, output: 0 } };
  const MAX = { provider: "agnes", id: "agnes-3.0-flash-max", cost: { input: 0, output: 0 } };
  const G1 = { provider: "gem", id: "gemini-2.0-flash-lite", cost: { input: 0, output: 0 } };
  const G2 = { provider: "gem", id: "gemini-2.10-flash-lite", cost: { input: 0, output: 0 } };
  const dir = tmpWs();
  assert.equal(resolveAuxModel({ wsRoot: dir, list: [MAIN, OLD, NEW, MAX], mainModel: MAIN }).model.id, "agnes-3.0-flash");
  // 版本按数字比，2.10 > 2.0；不同系列（-max）不算"新版本"
  assert.equal(resolveAuxModel({ wsRoot: dir, list: [MAIN, G1, G2], mainModel: MAIN }).model.id, "gemini-2.10-flash-lite");
  // 新版更贵时仍按单价：便宜优先的口径不变
  const PRICY = { ...NEW, cost: { input: 0.5, output: 1 } };
  assert.equal(resolveAuxModel({ wsRoot: dir, list: [MAIN, OLD, PRICY], mainModel: MAIN }).model.id, "agnes-2.5-flash");
});
