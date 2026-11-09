// 独立评估器（出处 evaluate_sop.py + sop_validate.py:133-186）：
// 五维写证据 / 严格更高才接受 / 判者分离 / 记账与 bestScore / 归一化防 Hermes 序号 bug
// 2026-11-09
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EVAL_LEDGER_REL, EVAL_DIMENSIONS, PASS_LINE, MAX_TOTAL, STEP_PREFIX_RE,
  normalizeStepText, actionabilityOfStep, scoreArtifact, compareToReference,
  judgeGate, evaluateArtifact, evaluateWithRatchet, readEvaluations, bestScore,
} from "../../engine/evaluator.mjs";
import { evaluatorRatchet } from "../../engine/evolution-gate.mjs";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "eval-"));
const writer = () => ({ sessionId: "writer-1" });
const judge = () => ({ sessionId: "judge-1", tools: [] });

const goodArtifact = (over = {}) => ({
  id: "sop-a",
  kind: "sop",
  content: "短内容",
  steps: ["1. 运行 node --test 跑单测", "2. 检查 输出没有 fail", "3、更新 文档"],
  evidence: {
    tests: { total: 8, passed: 8 },
    gate: "GREEN",
    steps: [{ name: "syntax", ok: true }, { name: "import", ok: true }, { name: "deps", ok: true }],
  },
  ...over,
});

const rubric = () => ({ maxChars: 400, minSteps: 2 });
/** 弱一档但五维齐全（总分 8）：accuracy 1（9/10）、safety 1（YELLOW）。 */
const weakerArtifact = () => goodArtifact({
  id: "sop-weak",
  evidence: {
    tests: { total: 10, passed: 9 },
    gate: "YELLOW",
    steps: [{ name: "syntax", ok: true }, { name: "import", ok: true }, { name: "deps", ok: true }],
  },
});

// ── 五维评分 + 证据来源 ──────────────────────────────────────

test("五维各有证据来源，满分 10 → passed", () => {
  assert.deepEqual([...EVAL_DIMENSIONS], ["accuracy", "completeness", "conciseness", "safety", "consistency"]);
  const s = scoreArtifact(goodArtifact(), rubric());
  assert.equal(s.total, MAX_TOTAL);
  assert.equal(s.max, 10);
  assert.equal(s.passLine, PASS_LINE);
  assert.equal(s.passed, true);
  assert.equal(s.ok, true);
  assert.deepEqual(s.unevaluated, []);
  for (const id of EVAL_DIMENSIONS) {
    assert.equal(s.dimensions[id].unevaluated, false, `${id} 不该是 unevaluated`);
    assert.equal(s.dimensions[id].score, 2);
    assert.ok(s.dimensions[id].source && s.dimensions[id].source.length > 3, `${id} 必须写明证据来源`);
  }
  // 证据来源要点名到底读了哪个字段
  assert.match(s.dimensions.accuracy.source, /evidence\.tests/);
  assert.match(s.dimensions.completeness.source, /artifact\.steps/);
  assert.match(s.dimensions.conciseness.source, /artifact\.content/);
  assert.match(s.dimensions.safety.source, /evidence\.gate/);
  assert.match(s.dimensions.consistency.source, /evidence\.steps/);
});

test("缺证据 → unevaluated 且 passed:false（不拿 0 分冒充差评）", () => {
  const s = scoreArtifact({ id: "half", evidence: { gate: "GREEN" } });
  assert.equal(s.passed, false);
  assert.deepEqual([...s.unevaluated].sort(), ["accuracy", "completeness", "conciseness", "consistency"]);
  for (const id of s.unevaluated) {
    assert.equal(s.dimensions[id].score, null, `${id} 不能记 0 分`);
    assert.equal(s.dimensions[id].unevaluated, true);
  }
  assert.equal(s.total, 2, "只有安全那一维有分");
  assert.match(s.reason, /没有证据/);
});

test("声明的维度分必须带 source，只给数字不算证据", () => {
  const noSource = scoreArtifact({ id: "x", evidence: { dimensions: { safety: 2 } } });
  assert.ok(noSource.unevaluated.includes("safety"));
  assert.match(noSource.judgeReasons.join("；"), /没写证据来源/);

  const withSource = scoreArtifact({ id: "y", evidence: { dimensions: { safety: { score: 2, source: "人工复核：无危险操作" } } } });
  assert.equal(withSource.dimensions.safety.score, 2);
  assert.match(withSource.dimensions.safety.source, /人工复核/);
});

test("分数低于通过线 → passed:false（但有分，不是 unevaluated）", () => {
  const low = scoreArtifact({
    id: "low", steps: ["1. 运行 a"], evidence: { tests: { total: 10, passed: 5 }, gate: "RED" },
  }, { minSteps: 1 });
  assert.equal(low.unevaluated.length, 2, "完整/简洁无证据");
  assert.equal(low.passed, false);
});

// ── 防 Hermes 序号 bug（evaluate_sop.py:109）──────────────────

test("序号归一化：带序号的 SOP 步骤能得分（钉住 Hermes 那个 bug）", () => {
  // 那个 bug：先判"动词开头"，而 SOP 步骤是 "1. 运行…" → 恒 0 分
  assert.match("1. 运行 node --test", /^\d+[.、)]/);
  assert.equal(/^(运行|检查|更新)/.test("1. 运行 node --test"), false, "这就是原 bug 的形状：序号挡在动词前面");

  assert.equal(normalizeStepText("1. 运行 node --test 跑单测"), "运行 node --test 跑单测");
  assert.equal(normalizeStepText("2、检查 输出"), "检查 输出");
  assert.equal(normalizeStepText("3) 更新 文档"), "更新 文档");
  assert.equal(normalizeStepText("（4）保存 结果"), "保存 结果");
  assert.equal(normalizeStepText("步骤5： 部署 到服务器"), "部署 到服务器");
  assert.equal(normalizeStepText("- 删除 临时文件"), "删除 临时文件");
  assert.equal(normalizeStepText("**6.** 记录 结果"), "记录 结果");
  // 小数不是序号，别剥错
  assert.equal(normalizeStepText("3.5 秒后重试 一次"), "3.5 秒后重试 一次");
  assert.equal(STEP_PREFIX_RE.test("1. 运行"), true);

  const numbered = actionabilityOfStep("1. 运行 node --test");
  assert.equal(numbered.actionable, true);
  assert.equal(numbered.verb, "运行");

  // 带序号的三步 → 完整度满分；同一批去掉序号也是满分（归一化不改变结论）
  const withNumbers = scoreArtifact(goodArtifact(), rubric());
  const noNumbers = scoreArtifact(goodArtifact({ steps: ["运行 node --test 跑单测", "检查 输出没有 fail", "更新 文档"] }), rubric());
  assert.equal(withNumbers.dimensions.completeness.score, 2);
  assert.equal(noNumbers.dimensions.completeness.score, 2);
  assert.match(withNumbers.dimensions.completeness.source, /已剥序号/);
});

test("序号归一化不放过真不合格的步骤（不是把所有步骤都算可执行）", () => {
  const bad = scoreArtifact(goodArtifact({ steps: ["1. 扫描", "2. 结果", "3. 2026 年的事"] }), rubric());
  assert.ok(bad.dimensions.completeness.score < 2);
  const r = actionabilityOfStep("1. 扫描");
  assert.equal(typeof r.actionable, "boolean");
  assert.equal(r.actionable, false, "「扫描」不在动词表里，不能算可执行");
});

// ── 严格大于才接受 ──────────────────────────────────────────

const sc = (total, dims) => ({ total, dimensions: dims });
const D8 = { accuracy: 2, completeness: 2, conciseness: 2, safety: 2, consistency: 0 };
const D9 = { accuracy: 2, completeness: 2, conciseness: 2, safety: 2, consistency: 1 };

test("严格大于才接受：等于不接受、小于不接受、大于才接受", () => {
  const equal = compareToReference({ candidate: sc(8, D8), reference: sc(8, D8) });
  assert.equal(equal.accept, false, "同分不算改进（元枢以前的病就是同分也替换）");
  assert.equal(equal.delta, 0);
  assert.match(equal.reason, /同分|不接受/);
  assert.equal(equal.dims.consistency.delta, 0);

  const better = compareToReference({ candidate: sc(9, D9), reference: sc(8, D8) });
  assert.equal(better.accept, true);
  assert.equal(better.delta, 1);
  assert.equal(better.dims.consistency.delta, 1);

  const worse = compareToReference({ candidate: sc(8, D8), reference: sc(9, D9) });
  assert.equal(worse.accept, false);
  assert.equal(worse.delta, -1);
  assert.deepEqual(worse.regressions, ["consistency"]);
});

test("阈值：Δ 必须严格大于 threshold（Δ=threshold 也不算）", () => {
  const eq = compareToReference({ candidate: sc(9, D9), reference: sc(8, D8), threshold: 1 });
  assert.equal(eq.accept, false, "Δ=1、阈值=1 → 不是严格大于");
  const gt = compareToReference({ candidate: sc(10, { ...D9, consistency: 2 }), reference: sc(8, D8), threshold: 1 });
  assert.equal(gt.accept, true);
});

test("候选有未评维度 → 不拿来替换参考", () => {
  const r = compareToReference({ candidate: { total: 9, dimensions: D9, unevaluated: ["conciseness"] }, reference: sc(8, D8) });
  assert.equal(r.accept, false);
  assert.match(r.reason, /未评|unevaluated/);
});

// ── 判者分离 ─────────────────────────────────────────────────

test("判者分离：同会话 / 带工具 / 缺 judge / 缺写者 → 全拒", () => {
  const sameSession = judgeGate({ writer: { sessionId: "s1" }, judge: { sessionId: "s1", tools: [] } });
  assert.equal(sameSession.ok, false);
  assert.match(sameSession.reason, /同一会话/);

  const withTools = judgeGate({ writer: { sessionId: "s1" }, judge: { sessionId: "s2", tools: ["bash", "write"] } });
  assert.equal(withTools.ok, false);
  assert.match(withTools.reason, /工具/);

  const noTools = judgeGate({ writer: { sessionId: "s1" }, judge: { sessionId: "s2" } });
  assert.equal(noTools.ok, false);
  assert.match(noTools.reason, /tools: \[\]|工具清单/);

  const noJudge = judgeGate({ writer: { sessionId: "s1" } });
  assert.equal(noJudge.ok, false);
  assert.match(noJudge.reason, /判者/);

  const noWriter = judgeGate({ judge: { sessionId: "s2", tools: [] } });
  assert.equal(noWriter.ok, false);
  assert.match(noWriter.reason, /写者/);

  const ok = judgeGate({ writer: { sessionId: "s1" }, judge: { sessionId: "s2", tools: [] } });
  assert.equal(ok.ok, true);
  assert.equal(ok.judge.tools, 0);
});

test("同会话的评估被拒，并记 violation", () => {
  const root = tmpRoot();
  const out = evaluateArtifact({
    artifact: goodArtifact(), rubric: rubric(), root, kind: "sop",
    writer: { sessionId: "same" }, judge: { sessionId: "same", tools: [] },
  });
  assert.equal(out.ok, false);
  assert.equal(out.refused, true);
  assert.equal(out.passed, false);
  const rows = readEvaluations(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "refused");
  assert.ok(rows[0].violation.length >= 1);
  assert.equal(rows[0].score, null);
  assert.equal(bestScore(root, "sop"), null, "violation 不能进历史最高分");
});

// ── 记账 + bestScore ─────────────────────────────────────────

test("记账：artifact/score/ref_score/dims/at 齐全，bestScore 取历史最高", () => {
  const root = tmpRoot();
  const first = evaluateArtifact({
    artifact: weakerArtifact(), rubric: rubric(), root, kind: "sop", writer: writer(), judge: judge(),
  });
  assert.equal(first.passed, true);
  assert.ok(fs.existsSync(path.join(root, EVAL_LEDGER_REL)), "记账要落 记忆/运行时/评估记账.jsonl");
  assert.equal(first.record.score, 8);
  assert.equal(first.record.ref_score, null);
  assert.deepEqual(Object.keys(first.record.dims).sort(), [...EVAL_DIMENSIONS].sort());
  assert.equal(typeof first.record.at, "string");

  const second = evaluateArtifact({
    artifact: goodArtifact(), rubric: rubric(), root, kind: "sop", writer: writer(), judge: judge(),
  });
  assert.equal(second.record.score, 10);
  assert.equal(second.record.ref_score, 8, "ref_score 记的是评估当时的历史最高分");

  assert.equal(bestScore(root, "sop").score, 10);
  assert.equal(bestScore(root, "sop").count, 2);
  assert.equal(bestScore(root, "other"), null);
  // 兼容单参写法 bestScore(kind)（root 用 "."）
  assert.equal(typeof bestScore("sop"), "object");
});

// ── 严格棘轮：首次接受，之后同分不接受 ──────────────────────

test("evaluateWithRatchet：没有历史分 → 记录首次分并接受", () => {
  const root = tmpRoot();
  const out = evaluateWithRatchet({
    artifact: goodArtifact(), rubric: rubric(), root, kind: "sop", writer: writer(), judge: judge(),
  });
  assert.equal(out.accepted, true);
  assert.equal(out.first, true);
  assert.match(out.reason, /没有历史分|首次/);
  assert.equal(out.score.total, 10);
  assert.equal(bestScore(root, "sop").score, 10);
});

test("evaluateWithRatchet：同分不接受；更高分成才接受", () => {
  const root = tmpRoot();
  // 先用弱一档的当参考（8 分），第一次即历史最高
  const base = evaluateWithRatchet({
    artifact: weakerArtifact(), rubric: rubric(), root, kind: "sop", writer: writer(), judge: judge(),
  });
  assert.equal(base.accepted, true);
  assert.equal(bestScore(root, "sop").score, 8);

  // 同分（再来一个 8 分）→ 不接受
  const same = evaluateWithRatchet({
    artifact: weakerArtifact(), rubric: rubric(), root, kind: "sop", writer: writer(), judge: judge(),
  });
  assert.equal(same.accepted, false);
  assert.equal(same.delta, 0);
  assert.match(same.reason, /同分|不接受/);

  // 更高（10 分）→ 接受
  const better = evaluateWithRatchet({
    artifact: goodArtifact(), rubric: rubric(), root, kind: "sop", writer: writer(), judge: judge(),
  });
  assert.equal(better.accepted, true);
  assert.equal(better.delta, 2);
  assert.equal(bestScore(root, "sop").score, 10);
});

test("enabled:false → 整段跳过（回退开关），不写记账", () => {
  const root = tmpRoot();
  const off = evaluateWithRatchet({
    artifact: goodArtifact(), rubric: rubric(), root, kind: "sop",
    enabled: false, writer: writer(), judge: judge(),
  });
  assert.equal(off.ok, true);
  assert.equal(off.skipped, true);
  assert.equal(off.accepted, false);
  assert.equal(readEvaluations(root).length, 0, "关掉时不该碰记账");
  assert.equal(bestScore(root, "sop"), null);
});

// ── 接线静态断言 ─────────────────────────────────────────────

test("接线静态断言：建在 ratchetGate 之上、bestScore 当参考、admit 里有开关", () => {
  const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
  const evalSrc = src("../../engine/evaluator.mjs");
  assert.match(evalSrc, /from "\.\/evolution-gate\.mjs"/);
  assert.match(evalSrc, /ratchetGate\(/);
  assert.match(evalSrc, /bestScore\(base, kindOf\)/);
  assert.match(evalSrc, /enabled: false|enabled === false/);
  assert.match(evalSrc, /compareToReference/);
  assert.match(evalSrc, /judgeGate/);

  const gateSrc = src("../../engine/evolution-gate.mjs");
  assert.match(gateSrc, /export async function evaluatorRatchet/);
  assert.match(gateSrc, /import\(['"]\.\/evaluator\.mjs['"]\)/);

  const admitSrc = src("../../engine/self-change-admit.mjs");
  assert.match(admitSrc, /import \{ gateBeforeAdmit, evaluatorRatchet \}/);
  assert.match(admitSrc, /evaluatorOpt\.enabled === true/);
  assert.match(admitSrc, /reject\("evaluator"/);
});

test("evolution-gate.evaluatorRatchet：能跑通、也能关", async () => {
  const root = tmpRoot();
  const on = await evaluatorRatchet({
    enabled: true, root, kind: "sop", artifact: goodArtifact(), rubric: rubric(), writer: writer(), judge: judge(),
  });
  assert.equal(on.accepted, true);
  assert.equal(on.skipped, false);
  assert.equal(bestScore(root, "sop").score, 10);

  const off = await evaluatorRatchet({ enabled: false });
  assert.equal(off.ok, true);
  assert.equal(off.skipped, true);
});
