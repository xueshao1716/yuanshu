// 反思产出经验：计数、校验、去重、写入（2026-10-31）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { countExperience, validateEntries, appendEntries, distillExperience, buildDistillPrompt, gatherEvidence, EXP_REL, latestReflectionReport } from "../../engine/reflection-experience.mjs";

const ws = (seed = "") => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exp-"));
  fs.mkdirSync(path.join(root, "工程", "经验库"), { recursive: true });
  fs.writeFileSync(path.join(root, EXP_REL), seed, "utf8");
  return root;
};
const good = (day = "2026-10-31") => [
  `### ${day} 交付门要防"声明已完成"`,
  "- 🔑 下次：声称完成前先跑 delivery_check，RED 就补验证",
  "- ⚠️ 工具回执成功不等于文件被验证",
].join("\n");

test("计数：### 日期 标题能数出来（修复 startsWith 永远 0 的 bug）", () => {
  const root = ws(`### 2026-10-30 旧条目\n- 一个要点\n\n## 2026-10-31 今天的\n- 要点\n`);
  assert.equal(countExperience(root, "2026-10-31"), 1);
  assert.equal(countExperience(root, "2026-10-30"), 1);
  assert.equal(countExperience(root, "2026-10-29"), 0);
});

test("校验：合格的条目通过，缺要点行被拒", () => {
  assert.equal(validateEntries(good(), "2026-10-31").ok, true);
  const bad = validateEntries("### 2026-10-31 标题\n只有一句话没有要点", "2026-10-31");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /要点/);
});

test("校验：超过 3 条被拒", () => {
  const many = [good(), good(), good(), good()].join("\n\n");
  const v = validateEntries(many, "2026-10-31");
  assert.equal(v.ok, false);
  assert.match(v.error, /3 条/);
});

test("校验：没有日期标题被拒（防止写无关内容）", () => {
  const v = validateEntries("### 2026-10-30 别的日子\n- 要点", "2026-10-31");
  assert.equal(v.ok, false);
  assert.match(v.error, /日期/);
});

test("写入：同标题去重", () => {
  const root = ws(good() + "\n");
  const out = appendEntries(root, [good()]);
  assert.equal(out.written, 0);
  assert.equal(out.skipped, 1);
});

test("写入：新标题追加成功，计数 +1", () => {
  const root = ws("");
  const out = appendEntries(root, [good()]);
  assert.equal(out.ok, true);
  assert.equal(out.written, 1);
  assert.equal(countExperience(root, "2026-10-31"), 1);
});

test("蒸馏：今天已有经验就跳过（不重复写）", async () => {
  const root = ws(good() + "\n");
  const r = await distillExperience({ wsRoot: root, day: "2026-10-31", evidence: { sessionNames: ["a"] }, write: async () => good() });
  assert.equal(r.written, 0);
  assert.match(r.reason, /已有经验/);
});

test("蒸馏：没有证据就跳过（不凭空编）", async () => {
  const root = ws("");
  const r = await distillExperience({ wsRoot: root, day: "2026-10-31", evidence: { sessionNames: [] }, write: async () => good() });
  assert.equal(r.written, 0);
  assert.match(r.reason, /没有可蒸馏/);
});

test("蒸馏：模型产出不合格时不写文件", async () => {
  const root = ws("");
  const r = await distillExperience({ wsRoot: root, day: "2026-10-31", evidence: { sessionNames: ["交付门"] }, write: async () => "随便说两句" });
  assert.equal(r.written, 0);
  assert.match(r.error, /不合格/);
  assert.equal(countExperience(root, "2026-10-31"), 0);
});

test("蒸馏：合格产物写入，返回条数与标题", async () => {
  const root = ws("");
  const r = await distillExperience({ wsRoot: root, day: "2026-10-31", evidence: { sessionNames: ["交付门", "主动推送"] }, write: async () => good() });
  assert.equal(r.ok, true);
  assert.equal(r.written, 1);
  assert.equal(r.count, 1);
  assert.match(r.titles[0], /交付门/);
});

test("提示词里带日期与证据，并要求不许编数字", () => {
  const p = buildDistillPrompt({ day: "2026-10-31", sessionNames: ["甲", "乙"], verdicts: ["RED(2 未覆盖)"], failures: ["npm test 失败"] });
  assert.match(p, /2026-10-31/);
  assert.match(p, /甲/);
  assert.match(p, /不许写没有证据支撑/);
});

test("gatherEvidence：过滤空名字、截断长文本", () => {
  const e = gatherEvidence({ sessions: [{ name: "甲" }, { name: "" }, { name: "乙" }], delivery: [{ verdict: "RED", uncovered: ["a", "b"] }], failures: [{ text: "x".repeat(200) }] });
  assert.deepEqual(e.sessionNames, ["甲", "乙"]);
  assert.equal(e.verdicts[0], "RED(2 未覆盖)");
  assert.ok(e.failures[0].length <= 80);
});

test('校验：只描述今天做了什么（没有下次）会被拒', () => {
  const flat = '### 2026-10-31 今天做了很多事\n- 🔑 跑了身份验证和交付门验证';
  const v = validateEntries(flat, '2026-10-31');
  assert.equal(v.ok, false);
  assert.match(v.error, /下次/);
});

const tasksFile = (root, tasks) => {
  const f = path.join(root, 'time-tasks.json');
  fs.writeFileSync(f, JSON.stringify({ tasks }), 'utf8');
  return f;
};

test('读她 0 点任务的复盘报告：取最新一条成功结果', () => {
  const root = ws();
  const f = tasksFile(root, [{ id: 't1', type: 'daily', at: '00:00', label: '自我反思', history: [
    { startedAt: 1000, status: 'ok', result: '旧报告' },
    { startedAt: 5000, status: 'ok', result: '新报告' },
    { startedAt: 9000, status: 'error', result: '' },
  ] }]);
  const r = latestReflectionReport({ tasksFile: f, now: 6000, maxAgeMs: 10_000 });
  assert.equal(r.ok, true);
  assert.equal(r.text, '新报告');
});

test('报告太旧就不算（避免拿昨天的报告充今天）', () => {
  const root = ws();
  const f = tasksFile(root, [{ id: 't1', type: 'daily', label: '自我反思', history: [{ startedAt: 1000, status: 'ok', result: '旧' }] }]);
  const r = latestReflectionReport({ tasksFile: f, now: 1000 + 25 * 3600 * 1000, maxAgeMs: 20 * 3600 * 1000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /太旧/);
});

test('没有反思任务时明确说没有', () => {
  const root = ws();
  const f = tasksFile(root, [{ id: 'x', type: 'once', label: '别的' }]);
  const r = latestReflectionReport({ tasksFile: f, now: 99999 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有反思任务/);
});

test('任务文件不存在也不炸', () => {
  const r = latestReflectionReport({ tasksFile: 'D:/definitely/not/here.json', now: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test('提示词里带她的复盘报告', () => {
  const p = buildDistillPrompt({ day: '2026-10-31', report: '昨天我把测试当成了业务验证', maxEntries: 2 });
  assert.match(p, /她自己的复盘报告/);
  assert.match(p, /把测试当成了业务验证/);
});
