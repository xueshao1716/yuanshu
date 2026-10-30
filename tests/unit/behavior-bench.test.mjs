// 行为题库：打分、对照、超时、存跑分（2026-10-30）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scoreCase, runBench, compareRuns, saveRun, listRuns, loadCases, casesPath, aggregateJudges, loadJudges, DEFAULT_JUDGES } from "../../engine/behavior-bench.mjs";

const c = (checks) => ({ id: "x", title: "用例", input: "hi", checks });

test("tool_called：没调就失败", () => {
  const r = scoreCase(c([{ kind: "tool_called", tool: "generate_image" }]), { text: "画好了", toolCalls: [] });
  assert.equal(r.pass, false);
  assert.match(r.failures[0], /generate_image/);
  const ok = scoreCase(c([{ kind: "tool_called", tool: "generate_image" }]), { text: "画好了", toolCalls: ["generate_image"] });
  assert.equal(ok.pass, true);
});

test("tool_not_called：调了不该调的失败", () => {
  const r = scoreCase(c([{ kind: "tool_not_called", tool: "bash" }]), { text: "好", toolCalls: ["bash"] });
  assert.equal(r.pass, false);
});

test("any_tool_called：一个都没调失败", () => {
  assert.equal(scoreCase(c([{ kind: "any_tool_called" }]), { text: "嗯", toolCalls: [] }).pass, false);
  assert.equal(scoreCase(c([{ kind: "any_tool_called" }]), { text: "嗯", toolCalls: ["read"] }).pass, true);
});

test("文本包含/不含 + 长度上限", () => {
  assert.equal(scoreCase(c([{ kind: "text_contains", value: "Example" }]), { text: "标题是 Example Domain" }).pass, true);
  assert.equal(scoreCase(c([{ kind: "text_not_contains", value: "DSML" }]), { text: "｜｜DSML｜｜" }).pass, false);
  assert.equal(scoreCase(c([{ kind: "max_chars", value: 10 }]), { text: "x".repeat(11) }).pass, false);
});

test("有 error 默认算失败（除非用例要求忽略）", () => {
  assert.equal(scoreCase(c([]), { text: "", error: "工具执行失败: boom" }).pass, false);
  assert.equal(scoreCase(c([{ kind: "ignore_error" }]), { text: "还行", error: "x" }).pass, true);
});

test("runBench：汇总通过率，单条异常不影响其它", async () => {
  const cases = [
    { id: "a", title: "A", input: "1", checks: [{ kind: "text_contains", value: "好" }] },
    { id: "b", title: "B", input: "2", checks: [{ kind: "text_contains", value: "好" }] },
  ];
  const out = await runBench({
    cases,
    executor: async ({ id }) => {
      if (id === "b") throw new Error("炸了");
      return { text: "好的", toolCalls: [] };
    },
  });
  assert.equal(out.total, 2);
  assert.equal(out.passed, 1);
  assert.equal(out.score, 50);
});

test("runBench：超时的用例算失败而不是卡死", async () => {
  const out = await runBench({
    cases: [{ id: "slow", title: "慢", input: "x", checks: [] }],
    executor: () => new Promise(() => {}),
    timeoutMs: 200,
  });
  assert.equal(out.passed, 0);
  assert.match(out.results[0].failures.join(" "), /超时/);
});

test("compareRuns：有退化就判 worse（哪怕总分涨了）", () => {
  const before = { score: 50, results: [{ id: "a", pass: true }, { id: "b", pass: false }] };
  const after = { score: 75, results: [{ id: "a", pass: false }, { id: "b", pass: true }, { id: "c", pass: true }] };
  const r = compareRuns(before, after);
  assert.equal(r.verdict, "worse");
  assert.equal(r.regressions.length, 1);
  assert.equal(r.regressions[0].id, "a");
  assert.match(r.summary, /退化 1 题/);
});

test("compareRuns：总分涨且无退化 → better", () => {
  const r = compareRuns(
    { score: 50, results: [{ id: "a", pass: true }, { id: "b", pass: false }] },
    { score: 100, results: [{ id: "a", pass: true }, { id: "b", pass: true }] },
  );
  assert.equal(r.verdict, "better");
  assert.equal(r.delta, 50);
});

test("compareRuns：一模一样 → same", () => {
  const r = compareRuns({ score: 100, results: [{ id: "a", pass: true }] }, { score: 100, results: [{ id: "a", pass: true }] });
  assert.equal(r.verdict, "same");
});

test("存跑分 + 列出来", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const p = saveRun(ws, { at: Date.now(), score: 75, results: [] }, { tag: "test" });
  assert.ok(fs.existsSync(p));
  assert.equal(listRuns(ws).length, 1);
});

test("题库缺失时返回空数组而不是抛错", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bench2-"));
  assert.deepEqual(loadCases(ws), []);
  assert.ok(casesPath(ws).includes("行为题库"));
});


// ── 异构评委（2026-10-30）──

test("聚合取最低分而不是平均：一个 0.2 一个 0.9，不能折中成 0.55", () => {
  const a = aggregateJudges([{ provider: "x", score: 0.9 }, { provider: "y", score: 0.2 }]);
  assert.equal(a.score, 0.2);
  assert.equal(a.disagree, true);
});

test("分歧阈值比较不受浮点毛刺影响（0.7 vs 1.0 差距按 0.3 算）", () => {
  const a = aggregateJudges([{ provider: "x", score: 0.7 }, { provider: "y", score: 1 }], { maxSpread: 0.3 });
  assert.equal(a.spread, 0.3);
  assert.equal(a.disagree, false, "恰好等于阈值不算超出");
});

test("没有有效分数时判 0 并标分歧", () => {
  const a = aggregateJudges([{ provider: "x", score: NaN }]);
  assert.equal(a.score, 0);
  assert.equal(a.disagree, true);
});

test("分歧默认只记录不判失败；显式 failOnDisagree 才失败", () => {
  const split = aggregateJudges([{ provider: "x", score: 0.65 }, { provider: "y", score: 1 }], { maxSpread: 0.2 });
  const c = (checks) => ({ id: "x", title: "t", input: "i", checks });
  const soft = scoreCase(c([{ kind: "judge", min: 0.6 }]), { judges: { default: split } });
  assert.equal(soft.pass, true, "两个评委都过线，只是意见不一，不该判失败");
  const hard = scoreCase(c([{ kind: "judge", min: 0.6, failOnDisagree: true }]), { judges: { default: split } });
  assert.equal(hard.pass, false);
  assert.match(hard.failures.join(" "), /评委分歧/);
});

test("评委配置：缺文件用默认两家不同 provider", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "judges-"));
  const cfg = loadJudges(ws);
  assert.ok(cfg.judges.length >= 2);
  const providers = new Set(cfg.judges.map((j) => j.provider));
  assert.ok(providers.size >= 2, "默认评委要来自不同 provider");
  assert.deepEqual(cfg.judges, DEFAULT_JUDGES);
});

test("评委配置：读工作区文件并可调阈值", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "judges2-"));
  fs.mkdirSync(path.join(ws, "评测"), { recursive: true });
  fs.writeFileSync(path.join(ws, "评测", "评分器.json"), JSON.stringify({
    judges: [{ provider: "a", modelId: "a1" }, { provider: "b", modelId: "b1" }], maxSpread: 0.5,
  }), "utf8");
  const cfg = loadJudges(ws);
  assert.equal(cfg.judges.length, 2);
  assert.equal(cfg.maxSpread, 0.5);
});

test("跑分结果保留评委明细（审计要能看出谁给了几分）", async () => {
  const out = await runBench({
    cases: [{ id: "a", title: "A", input: "x", checks: [{ kind: "judge", min: 0.5 }] }],
    executor: async () => ({ text: "答案", judges: { default: aggregateJudges([{ provider: "x", score: 0.9 }]) } }),
  });
  assert.ok(out.results[0].judges, "要保留 judges");
  assert.equal(out.results[0].judges.default.judges[0].provider, "x");
});
