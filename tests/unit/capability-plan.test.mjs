// accepted 之后自动产出改动计划 + 测试骨架（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planFor, testSkeleton, materializeProposal, AREA_PLAYBOOK } from "../../engine/capability-plan.mjs";

const P = {
  id: "abc123",
  title: "[反馈/上报] 进程异常退出（Timeout._onTimeout 里的未捕获异常）（同类 20 次）",
  area: "feedback",
  areaLabel: "反馈/上报",
  severity: 3,
  recurrence: 20,
  symptom: "[exit] code=1 uptime=3s pid=187327 caller=at Timeout._onTimeout",
  evidence: [{ source: "feedback", id: "54ce2826-1111", at: Date.now() }],
};

test("计划四件套齐：证据/动哪/怎么做/什么算完成", () => {
  const plan = planFor(P, { now: Date.parse("2026-10-26T00:00:00Z") });
  assert.equal(plan.area, "feedback");
  assert.ok(plan.files.length >= 1);
  assert.ok(plan.evidence.some((e) => e.includes("54ce2826")));
  assert.ok(plan.steps.length >= 4);
  assert.match(plan.accept, /研判|回信/);
  assert.match(plan.markdown, /## 证据/);
  assert.match(plan.markdown, /## 什么算完成/);
});

test("没留证据的提案，计划里明确要求先补证据（不许空手开工）", () => {
  const plan = planFor({ ...P, evidence: [] });
  assert.match(plan.markdown, /请先补/);
});

test("测试骨架全部是 todo（红着进主干是最坏的做法）", () => {
  const skeleton = testSkeleton(planFor(P));
  assert.match(skeleton, /t\.todo/);
  assert.doesNotMatch(skeleton, /assert\.equal\(/); // 骨架里不该有真断言
  assert.match(skeleton, /node:test/);
});

test("materialize 会写 PLAN.md 与测试骨架，并校验语法", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "plan-ws-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "plan-repo-"));
  const prev = process.cwd();
  process.chdir(repo);
  try {
    fs.mkdirSync(path.join(repo, "tests", "unit"), { recursive: true });
    const out = materializeProposal(ws, { ...P, id: "deadbeef" }, { now: Date.now() });
    assert.equal(out.ok, true, out.error);
    assert.ok(fs.existsSync(out.planPath));
    assert.ok(fs.existsSync(out.testPath), "骨架应写在仓库根");
    assert.match(fs.readFileSync(out.planPath, "utf8"), /# \[反馈\/上报\]/);
  } finally { process.chdir(prev) }
});

test("绝不覆盖已存在的测试文件（那是别人的地基）", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "plan-ws2-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "plan-repo2-"));
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const plan = planFor({ ...P, id: "cafe" });
    const target = path.join(repo, plan.testFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "// 我自己的测试，别动\n", "utf8");
    const out = materializeProposal(ws, { ...P, id: "cafe" });
    assert.equal(out.skippedTest, true);
    assert.equal(fs.readFileSync(target, "utf8"), "// 我自己的测试，别动\n");
  } finally { process.chdir(prev) }
});

test("每个领域都有 playbook（不然计划会退化成空话）", () => {
  for (const area of ["audio", "knowledge", "feedback", "shell", "deploy", "mcp", "general"]) {
    const pb = AREA_PLAYBOOK[area];
    assert.ok(pb.files.length, `${area} 缺 files`);
    assert.ok(pb.verify.length > 6, `${area} 缺验收标准`);
  }
});
