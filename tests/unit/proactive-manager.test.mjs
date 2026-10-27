// 主动管理：在盯什么、追什么、催几次就闭嘴（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addWatch, stopWatch, readState, collectOpenLoops, sweepProactive, proactiveLine, listProactive,
  NUDGE_COOLDOWN_MS, MAX_NUDGES, MAX_PER_SWEEP,
} from "../../engine/proactive-manager.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "proact-"));
const now0 = () => Date.now();

const makeFailed = (id, label, agoMs = 60000) => ({
  id, label, done: true, exitCode: 1,
  startedAt: Date.now() - agoMs, updatedAt: Date.now() - agoMs,
});

/** 先建基线（默认空场景），之后进来的才算"新事"。 */
function prime(root, scene = {}) {
  return sweepProactive({ wsRoot: root, ...scene, now: now0() });
}

test("盯一件事：写入账本，关键词自动分词；可以停掉", () => {
  const root = ws();
  const r = addWatch({ wsRoot: root, title: "资料库权限改造" });
  assert.equal(r.ok, true);
  const st = readState(root);
  assert.equal(st.watches.length, 1);
  assert.ok(st.watches[0].keywords.length >= 1);

  assert.equal(stopWatch({ wsRoot: root, id: r.id }).ok, true);
  assert.equal(readState(root).watches[0].status, "paused");
});

test("Open loops：失败作业 / 卡住作业 / 在盯的东西被命中", () => {
  const root = ws();
  addWatch({ wsRoot: root, title: "权限", keywords: ["权限"] });
  const loops = collectOpenLoops({
    wsRoot: root,
    detached: [
      makeFailed("j1", "渲染 45s"),
      { id: "j2", label: "导出", done: false, alive: true, startedAt: Date.now() - 3600000, updatedAt: Date.now() - 1800000 },
    ],
    docChanges: [{ path: "文档/权限说明.md", at: Date.now() }],
  });
  const kinds = loops.map((l) => l.kind).sort();
  assert.deepEqual(kinds, ["job-failed", "job-stalled", "watch-hit"]);
  assert.equal(loops.find((l) => l.kind === "job-failed").severity, "high");
});

test("首次扫只建基线：旧账闭环、不催、不写汇报", () => {
  const root = ws();
  const out = sweepProactive({ wsRoot: root, detached: [makeFailed("old", "两天前的作业", 48 * 3600000)], now: now0() });
  assert.equal(out.baseline, true);
  assert.equal(out.nudged.length, 0, "基线轮不该催");
  assert.equal(fs.existsSync(path.join(root, "记忆", "运行时", "待汇报.json")), false, "基线轮不该写汇报");
  assert.ok(listProactive(root).loops.every((l) => l.status === "done"), "历史旧账应闭环");

  const again = sweepProactive({ wsRoot: root, detached: [makeFailed("old", "两天前的作业", 48 * 3600000)], now: now0() + 1000 });
  assert.equal(again.nudged.length, 0, "旧账不该复活");
});

test("基线之后新出现的失败才会被追（并落汇报台账）", () => {
  const root = ws();
  prime(root, { detached: [] });
  const out = sweepProactive({ wsRoot: root, detached: [makeFailed("j1", "渲染 45s")], now: now0() + 1000 });
  assert.equal(out.nudged.length, 1);
  assert.equal(out.escalated.length, 0);

  const reports = JSON.parse(fs.readFileSync(path.join(root, "记忆", "运行时", "待汇报.json"), "utf8"));
  const rows = Array.isArray(reports) ? reports : reports.items || [];
  assert.ok(rows.some((r) => r.kind === "proactive"));
});

test("冷却期内不重复催；过了冷却可以再催", () => {
  const root = ws();
  const t0 = now0();
  prime(root, { detached: [] });
  const job = makeFailed("j1", "渲染");

  assert.equal(sweepProactive({ wsRoot: root, detached: [job], now: t0 }).nudged.length, 1);
  const again = sweepProactive({ wsRoot: root, detached: [job], now: t0 + 60000 });
  assert.equal(again.nudged.length, 0);
  assert.ok(again.skipped >= 1);

  const later = sweepProactive({ wsRoot: root, detached: [job], now: t0 + NUDGE_COOLDOWN_MS + 1000 });
  assert.equal(later.nudged.length, 1, "过了冷却可以再催一次");
});

test("催满上限后升级一次，再之后闭嘴", () => {
  const root = ws();
  const t0 = now0();
  prime(root, { detached: [] });
  const job = makeFailed("j1", "渲染");
  let now = t0;
  const results = [];
  for (let i = 0; i < MAX_NUDGES + 3; i += 1) {
    results.push(sweepProactive({ wsRoot: root, detached: [job], now }));
    now += NUDGE_COOLDOWN_MS + 1000;
  }
  assert.equal(results[0].nudged.length, 1);
  assert.ok(results.some((r) => r.escalated.length === 1), "应该升级过一次");
  assert.ok(results.at(-1).silent >= 1 || results.at(-1).nudged.length === 0, "最后应该闭嘴");
});

test("事情解决后闭环", () => {
  const root = ws();
  const t0 = now0();
  prime(root, { detached: [] });
  sweepProactive({ wsRoot: root, detached: [makeFailed("j1", "渲染")], now: t0 });
  assert.equal(listProactive(root).loops.filter((l) => l.status !== "done").length, 1);

  const after = sweepProactive({ wsRoot: root, detached: [], now: t0 + 1000 });
  assert.equal(after.total, 0);
  assert.ok(listProactive(root).loops.every((l) => l.status === "done"));
});

test(`每次最多催 ${MAX_PER_SWEEP} 条（宁可慢，不要刷屏）`, () => {
  const root = ws();
  prime(root, { detached: [] });
  const many = Array.from({ length: 8 }, (_, i) => makeFailed(`job${i}`, `作业${i}`));
  const out = sweepProactive({ wsRoot: root, detached: many, now: now0() + 1000 });
  assert.equal(out.nudged.length, MAX_PER_SWEEP);
  assert.ok(out.skipped >= 8 - MAX_PER_SWEEP);
});

test("太旧的失败不再追（避免一启动翻历史垃圾）", () => {
  const root = ws();
  const loops = collectOpenLoops({ wsRoot: root, detached: [makeFailed("old", "两天前", 48 * 3600000)] });
  assert.equal(loops.length, 0);
});

test("环境事实一行：有在盯或在跟随时非空，否则空", () => {
  const root = ws();
  assert.equal(proactiveLine(root), "");
  addWatch({ wsRoot: root, title: "盯住发布" });
  assert.match(proactiveLine(root), /主动管理/);
});

test("补丁躺太久会被追，超过 5 天算 high", () => {
  const root = ws();
  const loops = collectOpenLoops({ wsRoot: root, patches: { "auto/capability-x": { state: "awaiting_review", ageDays: 6, files: 2 } } });
  const patch = loops.find((l) => l.kind === "patch-pending");
  assert.ok(patch);
  assert.equal(patch.severity, "high");
});
