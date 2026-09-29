// 基因 / 技能基因 / 资产路由 单测（2026-08-19 拆模块 + P3）
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { initGene, updateGenes, geneBias, proposeBaselineChange, approveProposal, rejectProposal, rollbackSnapshot, getGenome, autoProposeFromDrift, geneDirective } from "../../engine/gene.mjs";
import { initSkillGene, detectSkillDomain, updateSkillGene, getSkillGenes, skillDirective, routerSkill, bindSkillIndex } from "../../engine/skill-gene.mjs";

// 临时工作空间（隔离测试，不碰真实记忆文件）
const tmpWs = path.join(os.tmpdir(), "gene-test-" + Date.now());
fs.mkdirSync(path.join(tmpWs, "工程", "经验库"), { recursive: true });
initGene(tmpWs);
initSkillGene(tmpWs);

// ── 基因层 ──
test("基因: 默认 11 基因加载", () => {
  const g = getGenome().genes;
  assert.equal(Object.keys(g).length, 11);
  assert.ok(g.gentleness.baseline > 0.7, "温柔基线应高");
  assert.ok(g.caution.mutability < g.learning.mutability, "谨慎应比学习更稳（mutability 低）");
});

test("基因: expression 微调不动 baseline", () => {
  const before = getGenome().genes.curiosity.baseline;
  updateGenes(["task_deep"]);
  const after = getGenome().genes.curiosity;
  assert.equal(after.baseline, before, "baseline 不能被 updateGenes 改");
  assert.ok(after.expression >= 0.78, "expression 应上涨");
});

test("基因: 提案制——批准应用 + 回滚", () => {
  const p = proposeBaselineChange("humor", 0.7, "测试提案", ["unit_test"]);
  assert.ok(p, "应生成提案");
  const r = approveProposal(p.proposal_id, "tester");
  assert.equal(r.approved, true);
  assert.equal(getGenome().genes.humor.baseline, 0.7);
  // 回滚
  const rb = rollbackSnapshot(r.snapshot_id);
  assert.equal(rb.ok, true);
  assert.equal(getGenome().genes.humor.baseline, 0.53);
});

test("基因: 拒绝提案", () => {
  const p = proposeBaselineChange("loyalty", 0.5, "不该发生的提案", ["unit_test"]);
  const r = rejectProposal(p.proposal_id, "tester", "忠诚不该降");
  assert.equal(r.rejected, true);
  assert.equal(getGenome().genes.loyalty.baseline, 0.91, "拒绝后基线不变");
});

test("基因: 变化太小(<0.01)不提案", () => {
  const p = proposeBaselineChange("gentleness", 0.805, "微小变化", ["unit_test"]);
  assert.equal(p, null);
});

test("基因: 明显漂移但没有连续来源证据不自动提案", () => {
  // 强行制造漂移：curiosity expression 拉到 0.9（baseline 0.78，差 0.12 ≥ 0.1）
  const g = getGenome();
  g.genes.curiosity.expression = 0.9;
  const props = autoProposeFromDrift();
  assert.equal(props.length, 0, "孤立数值不能冒充持续漂移证据");
});

test("基因: 行为指令随基因变化", () => {
  const d = geneDirective();
  assert.ok(d.includes("性格倾向"), "应含性格指令");
});

// ── 技能基因层 ──
test("技能基因: 领域识别", () => {
  assert.equal(detectSkillDomain("帮我做个PPT"), "ppt");
  assert.equal(detectSkillDomain("写一篇小说"), "writing");
  assert.equal(detectSkillDomain("修个bug"), "coding");
  assert.equal(detectSkillDomain("随便聊聊"), "general");
});

test("技能基因: 反馈更新（成功推高/失败拉低）", () => {
  const before = getSkillGenes().coding.reliability;
  updateSkillGene("coding", { success: true });
  const after = getSkillGenes().coding.reliability;
  assert.ok(after > before, "成功反馈应推高可靠性");
  updateSkillGene("coding", { success: false });
  assert.ok(getSkillGenes().coding.reliability < after, "失败反馈应拉低");
});

test("资产路由: 任务命中技能", () => {
  bindSkillIndex(() => [
    { name: "ppt-generator", summary: "生成 PPT 幻灯片，支持主题模板内容填充", desc: "PPT" },
    { name: "novel-forge-v10", summary: "小说创作系统，五层共进化", desc: "小说" },
    { name: "stock-analysis", summary: "股票分析，技术指标与预测", desc: "股票" },
  ]);
  const r = routerSkill("帮我把这份内容做成 PPT 幻灯片", 2);
  assert.ok(r.length >= 1, "应命中技能");
  assert.ok(r[0].name.includes("ppt"), `应命中 ppt 技能 (got ${r[0]?.name})`);
  const r2 = routerSkill("写一篇古风小说", 2);
  assert.ok(r2.length >= 1 && r2[0].name.includes("novel"), "应命中小说技能");
});

// 清理
fs.rmSync(tmpWs, { recursive: true, force: true });
