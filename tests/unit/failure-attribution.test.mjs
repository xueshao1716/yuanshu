// 失败归因（出处 xinyu-hermes replay_writer.py:31-38）：四类判定 + isSignal + 相似去重 + 自动打标接线
// 2026-11-09
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FAILURE_KINDS, SIGNAL_KINDS, KIND_LABELS, DEDUPE_THRESHOLD, ENV_IMPOSSIBLE_THRESHOLD,
  classifyFailure, isSignalKind, failureSimilarity, dedupeFailures, attributionReport,
  enqueueImprovement, listImprovementQueue, improvementLesson, envFailureCount, failureSignature,
} from "../../engine/failure-attribution.mjs";
import {
  recordFailure, readFailures, recentFailures, pruneFailures, failureAttribution, countSimilar, recordGateFailure,
} from "../../engine/failure-ledger.mjs";
import { loadLessonLedger } from "../../engine/lesson-promotion.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "attr-"));
const NOW = Date.now();
const base = { area: "改 doc-diff", attempt: "直接扫全盘", why: "20 万文件吃满上限", files: ["engine/doc-diff.mjs"], at: NOW };
const skill = { id: "doc-diff", name: "doc-diff 技能", steps: ["先列目录", "分批读取"] };
const envEntry = (i) => ({ ...base, id: `e${i}`, at: NOW - i * 1000, why: "找不到命令 rg：ENOENT（本机没装）" });

// ── 四类各一例 ────────────────────────────────────────────────

test("四类①任务不可能：同一命令因环境失败到阈值", () => {
  const r = classifyFailure(envEntry(1), { priorFailures: [envEntry(2), envEntry(3)] });
  assert.equal(r.kind, "task_impossible");
  assert.equal(r.isSignal, false);
  assert.match(r.reason, /环境/);
  assert.ok(r.confidence >= 0.8, `confidence 应高（实际 ${r.confidence}）`);
  assert.ok(r.evidence.length >= 2, "必须写清证据");
});

test("四类②工具不够：重试后成功", () => {
  const r = classifyFailure({ ...base, why: "第一次 CDN 500" }, { retrySucceeded: true });
  assert.equal(r.kind, "tool_insufficient");
  assert.equal(r.isSignal, false);
  assert.match(r.reason, /重试/);
});

test("四类③技能没照做：命中技能且有违规/跳过证据", () => {
  const r = classifyFailure({ ...base, why: "没有按技能步骤执行，跳过了分批读取" }, { skills: [skill] });
  assert.equal(r.kind, "skill_noncompliant");
  assert.equal(r.isSignal, true);
  assert.match(r.reason, /doc-diff|没照着做/);
  assert.ok(r.evidence.some((x) => /技能/.test(x)), "证据里要写明命中了哪个技能");
});

test("四类④技能缺知识：命中技能且原因指向缺知识", () => {
  const r = classifyFailure(
    { ...base, why: "技能 doc-diff 里没写超大文件怎么处理，缺少这条知识" },
    { skills: [skill] },
  );
  assert.equal(r.kind, "skill_knowledge_gap");
  assert.equal(r.isSignal, true);
  assert.match(r.reason, /没有覆盖|缺知识/);
});

// ── 边界：重试成功 / 环境性失败 / 证据不足 ─────────────────────

test("边界：单次环境失败不算任务不可能（还没到阈值）", () => {
  const r = classifyFailure({ ...base, why: "超时 30s 没响应" });
  assert.equal(r.kind, "tool_insufficient");
  assert.match(r.reason, /未达|次数/);
  assert.equal(envFailureCount({ ...base, why: "超时" }, { priorFailures: [] }), 1);
});

test("边界：环境失败次数到 3 才翻成任务不可能", () => {
  assert.equal(ENV_IMPOSSIBLE_THRESHOLD, 3);
  assert.equal(classifyFailure(envEntry(1), { priorFailures: [envEntry(2)] }).kind, "tool_insufficient");
  assert.equal(classifyFailure(envEntry(1), { priorFailures: [envEntry(2), envEntry(3)] }).kind, "task_impossible");
  // 同命令 + 环境原因才计数：不同原因的那条不算
  const same = { area: "扫描", attempt: "rg foo", why: "ENOENT" };
  const other = { area: "扫描", attempt: "rg foo", why: "输出为空" };
  assert.equal(envFailureCount({ ...same }, { priorFailures: [{ ...same }, { ...other }] }), 2);
});

test("边界：显式「已判定做不到」直接归任务不可能", () => {
  const r = classifyFailure({ ...base, kind: "impossible" });
  assert.equal(r.kind, "task_impossible");
  assert.ok(r.confidence > 0.9);
  assert.match(r.reason, /做不到/);
});

test("边界：证据不足 → 低置信 task_impossible + needsReview（不伪装成判准了）", () => {
  const r = classifyFailure({ area: "某件事", attempt: "试了一下", why: "结果不好" });
  assert.equal(r.kind, "task_impossible");
  assert.equal(r.isSignal, false);
  assert.ok(r.confidence < 0.5, `低置信（实际 ${r.confidence}）`);
  assert.equal(r.needsReview, true);
  assert.match(r.reason, /证据不足/);
});

test("边界：技能命中但失败原因是环境/工具 → 不归罪技能", () => {
  const r = classifyFailure({ ...base, why: "技能 doc-diff 跑的时候超时 30s" }, { skills: [skill] });
  assert.equal(r.kind, "tool_insufficient");
  assert.equal(r.isSignal, false);
  assert.match(r.reason, /技能|环境/);
});

test("边界：技能命中、没有别的线索 → 低置信「没照做」并标待复核", () => {
  const r = classifyFailure({ ...base, why: "结果和预期不一样" }, { skills: [skill] });
  assert.equal(r.kind, "skill_noncompliant");
  assert.equal(r.isSignal, true);
  assert.ok(r.confidence <= 0.6);
  assert.equal(r.needsReview, true);
});

// ── isSignal 只对两类为 true ─────────────────────────────────

test("isSignal 只对 skill_noncompliant / skill_knowledge_gap 为 true", () => {
  assert.deepEqual([...SIGNAL_KINDS].sort(), ["skill_knowledge_gap", "skill_noncompliant"]);
  for (const k of FAILURE_KINDS) {
    assert.equal(isSignalKind(k), k === "skill_noncompliant" || k === "skill_knowledge_gap", `${k} 的 isSignal 判错了`);
  }
  assert.equal(isSignalKind("unknown_kind"), false);
  // 四类样例的返回值也要一致
  const samples = [
    classifyFailure(envEntry(1), { priorFailures: [envEntry(2), envEntry(3)] }),
    classifyFailure({ ...base, why: "第一次 CDN 500" }, { retrySucceeded: true }),
    classifyFailure({ ...base, why: "没有按技能步骤执行" }, { skills: [skill] }),
    classifyFailure({ ...base, why: "技能里没写这种情况，缺少知识" }, { skills: [skill] }),
  ];
  for (const s of samples) assert.equal(s.isSignal, isSignalKind(s.kind));
  assert.equal(samples.filter((s) => s.isSignal).length, 2);
});

// ── 相似去重 ─────────────────────────────────────────────────

test("相似去重：≥0.85 合并成一条，不相干的不合并", () => {
  const a = { ...base, id: "a" };
  const b = { ...base, id: "b", at: NOW - 1000, why: "20 万文件吃满上限（OOM）" };
  const c = { id: "c", area: "微信发图", attempt: "用 sendImage 直接发", why: "CDN 500", files: ["engine/wechat/ilink.mjs"] };
  assert.ok(failureSimilarity(a, b) >= DEDUPE_THRESHOLD, `a~b 应 ≥0.85（实际 ${failureSimilarity(a, b)}）`);
  assert.ok(failureSimilarity(a, c) < DEDUPE_THRESHOLD, `a~c 应 <0.85（实际 ${failureSimilarity(a, c)}）`);

  const out = dedupeFailures([a, b, c]);
  assert.equal(out.items.length, 2);
  assert.equal(out.mergedCount, 1);
  assert.equal(out.items[0].occurrences, 2, "合并后次数不能丢");
  assert.deepEqual(out.items[0].mergedIds, ["b"]);
  assert.equal(out.items[0].id, "a", "保留最新那条（含它的归因）");
  assert.equal(typeof failureSignature(a), "string");
});

test("相似去重落到台账：prune 默认 dry-run，apply 后累计次数不丢", () => {
  const root = ws();
  recordFailure({ wsRoot: root, area: "改 doc-diff", attempt: "直接扫全盘", why: "20 万文件吃满上限" });
  recordFailure({ wsRoot: root, area: "改 doc-diff", attempt: "直接扫全盘", why: "20 万文件吃满上限（OOM）" });
  recordFailure({ wsRoot: root, area: "微信发图", attempt: "用 sendImage 直接发", why: "CDN 500" });

  const dry = pruneFailures({ wsRoot: root });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.mergedCount, 1);
  assert.equal(readFailures(root).items.length, 3, "dry-run 不许动台账");

  const applied = pruneFailures({ wsRoot: root, dryRun: false });
  assert.equal(applied.after, 2);
  assert.equal(readFailures(root).items.length, 2);
  // 合并进那条带 occurrences，countSimilar 的阈值语义不变（还能数出 2 次）
  assert.equal(countSimilar({ wsRoot: root, area: "改 doc-diff" }).times, 2);
});

// ── 自动打标 + 改进队列（接 lesson-promotion）──────────────────

test("自动打标：非信号失败不进改进队列", () => {
  const root = ws();
  const r = recordFailure({
    wsRoot: root, area: "微信发图", attempt: "用 sendImage 直接发", why: "工具不存在", ctx: { retrySucceeded: true },
  });
  assert.equal(r.ok, true);
  assert.equal(r.entry.attribution.kind, "tool_insufficient");
  assert.equal(r.attribution.isSignal, false);
  assert.equal(r.improvement, null);
  assert.equal(listImprovementQueue(root).length, 0);
});

test("自动打标：信号进改进队列，相似信号合并，并落一条教训候选", () => {
  const root = ws();
  const first = recordFailure({
    wsRoot: root, area: "改 doc-diff", attempt: "直接扫全盘", why: "没有按技能步骤执行", ctx: { skills: [skill] },
  });
  assert.equal(first.entry.attribution.kind, "skill_noncompliant");
  assert.equal(first.improvement.ok, true);
  assert.equal(first.improvement.created, true);
  assert.equal(first.improvement.lesson.appended, true);

  const queue = listImprovementQueue(root);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].kind, "skill_noncompliant");
  assert.equal(queue[0].occurrences, 1);
  assert.equal(queue[0].status, "open");
  assert.equal(queue[0].failureId, first.entry.id);

  const second = recordFailure({
    wsRoot: root, area: "改 doc-diff", attempt: "直接扫全盘", why: "没有按技能步骤执行", ctx: { skills: [skill] },
  });
  assert.equal(second.improvement.created, false, "相似信号应合并，不新增");
  assert.equal(second.improvement.item.occurrences, 2);
  assert.equal(listImprovementQueue(root).length, 1);

  // 接 lesson-promotion：教训账里有一条可被复盘复现晋升的候选
  const ledger = loadLessonLedger(root);
  const mine = ledger.lessons.filter((l) => l.source === "failure-attribution");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].kind, "skill_noncompliant");
  assert.match(mine[0].ymd, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(mine[0].failureId, first.entry.id);
});

test("改进队列：非信号直接拒收（防线在入口，不靠调用方自觉）", () => {
  const root = ws();
  const r = enqueueImprovement({
    wsRoot: root, entry: { id: "x", area: "a", attempt: "b", why: "c" },
    attribution: { kind: "task_impossible", isSignal: false },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /isSignal|可改进信号/);
  assert.equal(listImprovementQueue(root).length, 0);
});

test("improvementLesson：队列条目能转成 lesson-promotion 的教训形状", () => {
  const it = improvementLesson({ kind: "skill_knowledge_gap", area: "改 doc-diff", why: "技能里没写超大文件怎么处理" });
  assert.match(it.text, /技能缺知识/);
  assert.match(it.text, /改 doc-diff/);
  assert.equal(it.topic, "改 doc-diff");
});

// ── 看板 API ─────────────────────────────────────────────────

test("看板：四类分布 + 信号计数 + 最近条目 + 改进队列", () => {
  const root = ws();
  recordFailure({ wsRoot: root, area: "微信发图", attempt: "用 sendImage 直接发", why: "工具不存在" });
  recordFailure({ wsRoot: root, area: "改 doc-diff", attempt: "直接扫全盘", why: "没有按技能步骤执行", ctx: { skills: [skill] } });

  const report = failureAttribution({ wsRoot: root, limit: 2 });
  assert.deepEqual(Object.keys(report.distribution).sort(), [...FAILURE_KINDS].sort());
  assert.equal(report.total, 2);
  assert.equal(report.signal, 1);
  assert.equal(report.nonSignal, 1);
  assert.equal(report.distribution.skill_noncompliant, 1);
  assert.equal(report.signalReasons.skill_noncompliant, 1);
  assert.equal(report.recent.length, 2);
  assert.equal(report.recent[0].isSignal, true);
  assert.equal(report.recent[0].kindLabel, KIND_LABELS[report.recent[0].kind]);
  assert.ok(Array.isArray(report.queue) && report.queue.length === 1);
});

test("看板：旧条目（没有 attribution）现场归因并标 inferred", () => {
  const root = ws();
  const file = path.join(root, "记忆", "运行时", "失败台账.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    items: [{ id: "old", at: NOW, area: "微信发图", attempt: "用 sendImage 直接发", why: "工具不存在 sendImage", files: [] }],
  }), "utf8");
  const report = failureAttribution({ wsRoot: root, limit: 1 });
  assert.equal(report.recent[0].inferred, true);
  assert.equal(report.recent[0].kind, "tool_insufficient");
});

test("纯函数报告：不传条目的 distribution 也能算（attributionReport 不碰盘）", () => {
  const report = attributionReport({ items: [{ ...base, why: "工具不存在" }] });
  assert.equal(report.total, 1);
  assert.equal(Object.values(report.distribution).reduce((a, b) => a + b, 0), 1);
  assert.equal(report.recent[0].confidence > 0, true);
});

// ── 静态接线断言 ─────────────────────────────────────────────

test("验收关口失败也能入库并自动打标（source=gate）", () => {
  const root = ws();
  const r = recordGateFailure({
    wsRoot: root, stage: "ratchet", area: "自改准入：engine/x.mjs",
    reason: "维度回归：accuracy 1 < 2", files: ["engine/x.mjs"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.entry.source, "gate");
  assert.equal(r.entry.agent, "admit");
  assert.ok(FAILURE_KINDS.includes(r.entry.attribution.kind));
  assert.equal(typeof r.entry.attribution.isSignal, "boolean");
});

test("接线静态断言：台账自动打标 + server 路由在", () => {
  const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
  const ledger = src("../../engine/failure-ledger.mjs");
  assert.match(ledger, /from "\.\/failure-attribution\.mjs"/);
  assert.match(ledger, /classifyFailure\(entry/);
  assert.match(ledger, /enqueueImprovement\(/);
  assert.match(ledger, /entry\.attribution = attribution/);
  assert.match(ledger, /export function recordGateFailure/);

  // 交付/验收流程：准入闸的三处失败（自证/棘轮/评估器）都会落台账
  const admit = src("../../engine/self-change-admit.mjs");
  assert.match(admit, /import \{ recordGateFailure \} from "\.\/failure-ledger\.mjs"/);
  assert.match(admit, /noteGateFailure\("verify"/);
  assert.match(admit, /noteGateFailure\("ratchet"/);
  assert.match(admit, /noteGateFailure\("evaluator"/);

  const server = src("../../server.mjs");
  assert.match(server, /"GET", "\/api\/failures\/attribution"/);
  assert.match(server, /failureAttribution\(\{ wsRoot: WS_ROOT, limit \}\)/);

  assert.equal(recentFailures(ws(), { limit: 3 }).length, 0, "空台账不该炸");
});
