// 结构化经验：必须可追溯、成败不由自己宣称（2026-11-03）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExperience, recordExperience, readExperiences, summarizeExperiences } from "../../engine/learning/experience.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "exp-"));
const good = { runId: "run-123", goal: "完成 Python 工具", success: true, taskType: "coding", actions: ["write", { tool: "bash" }], errors: ["超时"], lessons: ["先写测试"], minutes: 12 };

test("缺 runId 不能成为经验", () => {
  const r = buildExperience({ ...good, runId: "" });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(";"), /追溯/);
});

test("success 必须是布尔（不许自称）", () => {
  const r = buildExperience({ ...good, success: "ok" });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(";"), /布尔/);
});

test("归一化：动作/错误统一成对象，长度受限", () => {
  const r = buildExperience(good).experience;
  assert.deepEqual(r.actions[0], { tool: "write" });
  assert.equal(r.actions[1].tool, "bash");
  assert.equal(r.errors[0].message, "超时");
  assert.equal(r.result.success, true);
  assert.equal(r.result.quality_score, null);
  assert.equal(r.cost.minutes, 12);
  assert.ok(r.experience_id.startsWith("exp_"));
});

test("落盘 + 读回 + 统计", () => {
  const root = ws();
  assert.equal(recordExperience(root, good).ok, true);
  recordExperience(root, { ...good, runId: "run-2", success: false, taskType: "coding" });
  recordExperience(root, { ...good, runId: "run-3", taskType: "writing" });
  const list = readExperiences(root);
  assert.equal(list.length, 3);
  const s = summarizeExperiences(list);
  const coding = s.find((x) => x.taskType === "coding");
  assert.equal(coding.total, 2);
  assert.equal(coding.success, 1);
  assert.equal(coding.failed, 1);
  assert.equal(coding.withLessons, 2);
});

test("不合格的经验不落盘", () => {
  const root = ws();
  const r = recordExperience(root, { goal: "x", success: true });
  assert.equal(r.ok, false);
  assert.equal(readExperiences(root).length, 0);
});
