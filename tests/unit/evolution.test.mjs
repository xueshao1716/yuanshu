// evolution-api：提案制红线——变体只进池、审批才写回、写回前备份
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initEvolutionApi,
  proposeEvolution,
  applyEvolution,
  listEvolution,
  evaluateProposal,
  dismissEvolution,
  proposeMemoryNudge,
  applyMemoryNudge,
  listMemoryNudges,
  analyzeMemoryCompress,
} from "../../engine/evolution-api.mjs";

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evo-"));
  const prompts = path.join(root, "prompts");
  const skills = path.join(root, "skills");
  fs.mkdirSync(prompts);
  fs.mkdirSync(skills);
  fs.mkdirSync(path.join(root, "工程", "经验库"), { recursive: true });
  const original = "# demo\n\nYou are a helper. Follow the user's instructions carefully and keep the format stable.\n";
  fs.writeFileSync(path.join(prompts, "demo.md"), original);
  return { root, prompts, skills, original };
}

function mockChat(payload) {
  return async () => ({ text: JSON.stringify(payload) });
}

test('evolution refuses traversal before invoking a model', async () => {
  const { root, prompts, skills, original } = harness();
  fs.writeFileSync(path.join(root, 'outside.md'), original);
  let calls = 0;
  initEvolutionApi({ root, prompts, skills, chat: async () => { calls++; return { text: '{}' }; } });
  assert.ok((await proposeEvolution({ name: '../outside' })).error);
  assert.equal(calls, 0);
});

test('evolution cannot overwrite a template edited after proposal creation', async () => {
  const { root, prompts, skills, original } = harness();
  initEvolutionApi({ root, prompts, skills, chat: mockChat({ variants: [{ label: 'A', content: original + ' Improved.' }] }) });
  const proposal = await proposeEvolution({ name: 'demo' });
  fs.writeFileSync(path.join(prompts, 'demo.md'), 'new user content');
  assert.ok(applyEvolution(proposal.id).error);
  assert.equal(fs.readFileSync(path.join(prompts, 'demo.md'), 'utf8'), 'new user content');
  assert.equal(listEvolution()[0].state, 'open');
});

test('evolution refuses legacy proposals without a baseline digest', async () => {
  const { root, prompts, skills, original } = harness();
  initEvolutionApi({ root, prompts, skills });
  fs.writeFileSync(path.join(root, '工程/经验库/improvements.jsonl'), JSON.stringify({ id: 'legacy', kind: 'evolution', state: 'open', target: { name: 'demo' }, variants: [{ content: original + ' Changed.' }] }));
  assert.ok(applyEvolution('legacy').error);
  assert.equal(fs.readFileSync(path.join(prompts, 'demo.md'), 'utf8'), original);
});

test("proposeEvolution：变体进提案池，不直接改模板", async () => {
  const { root, prompts, skills, original } = harness();
  initEvolutionApi({
    root, prompts, skills,
    chat: mockChat({
      analysis: "用户常纠正格式",
      variants: [
        { label: "A", rationale: "加格式约束", content: original + "\nAlways output markdown lists with sources." },
        { label: "B", rationale: "加确认步骤", content: original + "\nConfirm the goal before acting on files." },
      ],
    }),
  });
  const r = await proposeEvolution({ name: "demo", model: { provider: "x", id: "y" } });
  assert.equal(r.ok, true);
  assert.equal(r.variants, 2);
  assert.equal(fs.readFileSync(path.join(prompts, "demo.md"), "utf8"), original);
  const list = listEvolution();
  assert.equal(list.length, 1);
  assert.equal(list[0].state, "open");
  assert.equal(list[0].kind, "evolution");
});

test("过短变体被约束门全部挡下", async () => {
  const { root, prompts, skills } = harness();
  initEvolutionApi({
    root, prompts, skills,
    chat: mockChat({
      analysis: "无效",
      variants: [
        { label: "A", rationale: "太短", content: "short" },
        { label: "B", rationale: "也短", content: "tiny" },
      ],
    }),
  });
  const r = await proposeEvolution({ name: "demo", model: { provider: "x", id: "y" } });
  assert.ok(r.error);
  assert.equal(listEvolution().length, 0);
});

test("applyEvolution：写回模板并留下原版备份", async () => {
  const { root, prompts, skills, original } = harness();
  const evolved = original + "\nAlways cite the file you changed.";
  initEvolutionApi({
    root, prompts, skills,
    chat: mockChat({
      analysis: "漏引用",
      variants: [
        { label: "A", rationale: "强制引用", content: evolved },
        { label: "B", rationale: "备选", content: original + "\nAsk before deleting anything important." },
      ],
    }),
  });
  const r = await proposeEvolution({ name: "demo", model: { provider: "x", id: "y" } });
  assert.ok(applyEvolution(r.id, 0).error, 'unreviewed candidates cannot be applied');
  initEvolutionApi({ root, prompts, skills, chat: async (_model, messages) => ({ text:
    messages[0].content.includes('出题器') ? JSON.stringify({ questions: ['常规任务', '边界任务'] }) :
      messages[0].content.includes('严格评委') ? '85/100' : '实际回答，供人工对照。' }) });
  const evaluated = await evaluateProposal(r.id, { provider: 'fixture', id: 'judge' });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.evaluation.original.scores[0], 85);
  assert.equal(evaluated.evaluation.original.answers.length, 2);
  const review = { evaluationId: evaluated.evaluation.id, comparisons: ['better', 'equal'], note: '逐题核对，引用更完整，无新增错误' };
  assert.ok(applyEvolution(r.id, 0, { ...review, comparisons: ['better', 'worse'] }).error);
  assert.ok(applyEvolution(r.id, 0, { ...review, evaluationId: 'stale' }).error);
  const applied = applyEvolution(r.id, 0, review);
  assert.equal(applied.ok, true);
  assert.ok(applied.backup);
  assert.equal(fs.readFileSync(path.join(prompts, "demo.md"), "utf8"), evolved);
  assert.equal(fs.readFileSync(path.join(prompts, applied.backup), "utf8"), original);
  assert.equal(listEvolution()[0].state, "applied");
});

test("dismissEvolution 后不可再 apply", async () => {
  const { root, prompts, skills, original } = harness();
  initEvolutionApi({
    root, prompts, skills,
    chat: mockChat({
      analysis: "x",
      variants: [
        { label: "A", rationale: "a", content: original + "\nKeep answers under two paragraphs unless asked." },
        { label: "B", rationale: "b", content: original + "\nPrefer checklists when the task has steps." },
      ],
    }),
  });
  const r = await proposeEvolution({ name: "demo", model: { provider: "x", id: "y" } });
  assert.equal(dismissEvolution(r.id).ok, true);
  const again = applyEvolution(r.id, 0);
  assert.ok(again.error);
  assert.equal(fs.readFileSync(path.join(prompts, "demo.md"), "utf8"), original);
});

test("proposeMemoryNudge：跨阈值提案；同日同类去重", () => {
  const { root, prompts, skills } = harness();
  initEvolutionApi({ root, prompts, skills });
  const a = proposeMemoryNudge({ subtype: "warmth", residue: 0.6, message: "今天这事办得很漂亮" });
  assert.equal(a.ok, true);
  const dup = proposeMemoryNudge({ subtype: "warmth", residue: 0.7, message: "又一次" });
  assert.equal(dup.skip, true);
  const applied = applyMemoryNudge(a.id);
  assert.equal(applied.ok, true);
  const fp = path.join(root, "记忆", "关系记忆.md");
  assert.ok(fs.readFileSync(fp, "utf8").includes("今天这事办得很漂亮"));
  assert.equal(listMemoryNudges()[0].state, "applied");
});

test("analyzeMemoryCompress：14 天内条目不算早期", () => {
  const { root, prompts, skills } = harness();
  initEvolutionApi({ root, prompts, skills });
  const today = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(root, "记忆"), { recursive: true });
  fs.writeFileSync(path.join(root, "记忆", "记忆日志.md"), `## ${today}\n今天写了进化引擎测试\n`);
  const a = analyzeMemoryCompress();
  assert.equal(a.total, 1);
  assert.equal(a.old, 0);
  assert.equal(a.worthIt, false);
});
