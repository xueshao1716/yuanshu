// 无人值守补丁：范围/限量/失败回滚/永不并 main（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parsePatch, validatePatch, buildPrompt, MAX_FILES } from "../../engine/patch-generator.mjs";
import { pickEligible, runProposal } from "../../engine/patch-runner.mjs";
import { refreshProposals, readProposals } from "../../engine/capability-proposal.mjs";

function repo(withGit = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
  fs.mkdirSync(path.join(root, "engine"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "unit"), { recursive: true });
  fs.writeFileSync(path.join(root, "engine", "a.mjs"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "tests", "unit", "ok.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => { assert.equal(1, 1); });\n', "utf8");
  if (withGit) {
    spawnSync("git", ["init", "-b", "main"], { cwd: root });
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"], { cwd: root });
  }
  return root;
}

function ws() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-ws-"));
  return root;
}

test("parsePatch 容忍代码围栏与前后废话", () => {
  const ok = parsePatch('好的：\n```json\n{"files":[{"path":"engine/a.mjs","content":"x"}],"note":"n"}\n```');
  assert.equal(ok.ok, true);
  assert.equal(ok.files.length, 1);
  assert.equal(parsePatch("没有 JSON").ok, undefined);
  assert.match(parsePatch("没有 JSON").error, /找不到/);
});

test("白名单/数量/体积三条都拦（整体拒绝，不做部分应用）", () => {
  const root = repo();
  const plan = { files: ["engine/a.mjs"] };
  assert.equal(validatePatch(root, plan, { files: [{ path: "engine/a.mjs", content: "ok" }] }).ok, true);
  const out = validatePatch(root, plan, { files: [{ path: "server.mjs", content: "x" }] });
  assert.equal(out.ok, false);
  assert.match(out.error, /不在计划范围内/);

  const tooMany = validatePatch(root, plan, { files: Array.from({ length: MAX_FILES + 1 }, () => ({ path: "engine/a.mjs", content: "x" })) });
  assert.match(tooMany.error, /文件太多/);

  const tooBig = validatePatch(root, plan, { files: [{ path: "engine/a.mjs", content: "x".repeat(20_001) }] });
  assert.match(tooBig.error, /超过/);

  const empty = validatePatch(root, plan, { files: [] , note: "做不了" });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /放弃/);
});

test("提示词只许产出 JSON，不许自由发挥", () => {
  const p = buildPrompt({ title: "t", files: ["engine/a.mjs"], accept: "断言 X" });
  assert.match(p, /\{"files":\[/);
  assert.match(p, /完整文件内容/);
  assert.match(p, /定点补丁|edits/);
  assert.match(p, /find 必须在文件里/);
});

test("没牌可打时 pickEligible 返回 nothing_eligible", () => {
  const w = ws();
  const r = pickEligible(w, { now: Date.now() });
  assert.equal(r.skip, "nothing_eligible");
});

test("生成器给了范围外的文件 → 不落盘，写回原因，次数+1", async () => {
  const w = ws();
  refreshProposals(w, {});
  // 手工塞一条 accepted + plan
  const data = readProposals(w);
  const planPath = path.join(w, "PLAN.md");
  fs.writeFileSync(planPath, "# t\n\n- `engine/a.mjs`\n", "utf8");
  data.items.push({ id: "p1", state: "accepted", area: "shell", title: "t", symptom: "s", files: ["engine/a.mjs"], planPath, attempts: 0, plan: { refinement: { complete: true, samples: [{ text: 'x' }], sites: [{ path: 'engine/a.mjs', line: 1 }] } } });
  fs.writeFileSync(path.join(w, "记忆", "运行时", "能力提案.json"), JSON.stringify(data), "utf8");

  const root = repo();
  const out = await runProposal({ wsRoot: w, repoRoot: root, proposal: data.items.at(-1), generate: async () => ({ files: [{ path: "server.mjs", content: "x" }] }) });
  assert.equal(out.ok, false);
  assert.equal(out.stage, "validate");
  const after = readProposals(w).items.find((p) => p.id === "p1");
  assert.equal(after.attempts, 1);
  assert.match(after.note, /未通过校验/);
  assert.equal(fs.readFileSync(path.join(root, "engine", "a.mjs"), "utf8"), "export const a = 1;\n", "不能有半截改动");
});

test("门禁拦下 → 自动回滚、工作树干净、原因写回", async () => {
  const w = ws();
  refreshProposals(w, {});
  const data = readProposals(w);
  const planPath = path.join(w, "PLAN.md");
  fs.writeFileSync(planPath, "# t\n\n- `engine/a.mjs`\n", "utf8");
  data.items.push({ id: "p2", state: "accepted", area: "shell", title: "t", symptom: "s", files: ["engine/a.mjs"], planPath, attempts: 0, plan: { refinement: { complete: true, samples: [{ text: 'x' }], sites: [{ path: 'engine/a.mjs', line: 1 }] } } });
  fs.writeFileSync(path.join(w, "记忆", "运行时", "能力提案.json"), JSON.stringify(data), "utf8");

  const root = repo();
  const out = await runProposal({
    wsRoot: w, repoRoot: root, proposal: data.items.at(-1),
    generate: async () => ({ files: [{ path: "engine/a.mjs", content: "const broken = (;\n" }] }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.stage, "gate");
  assert.equal(fs.readFileSync(path.join(root, "engine", "a.mjs"), "utf8"), "export const a = 1;\n");
  assert.match(readProposals(w).items.find((p) => p.id === "p2").note, /已回滚/);
});

test("成功：只建 auto/ 分支并提交，**留在原分支**，绝不并 main", async () => {
  const w = ws();
  refreshProposals(w, {});
  const data = readProposals(w);
  const planPath = path.join(w, "PLAN.md");
  fs.writeFileSync(planPath, "# t\n\n- `engine/a.mjs`\n", "utf8");
  data.items.push({ id: "p3", state: "accepted", area: "shell", title: "t", symptom: "s", files: ["engine/a.mjs"], planPath, attempts: 0, plan: { refinement: { complete: true, samples: [{ text: 'x' }], sites: [{ path: 'engine/a.mjs', line: 1 }] } } });
  fs.writeFileSync(path.join(w, "记忆", "运行时", "能力提案.json"), JSON.stringify(data), "utf8");

  const root = repo(true);
  const out = await runProposal({
    wsRoot: w, repoRoot: root, proposal: data.items.at(-1),
    generate: async () => ({ files: [{ path: "engine/a.mjs", content: "export const a = 2;\n" }], note: "改常量" }),
  });
  assert.equal(out.ok, true, out.error);
  assert.match(out.branch, /^auto\/capability-/);

  const cur = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.equal(cur, "main", "必须回到 main");
  const branches = spawnSync("git", ["branch", "--list"], { cwd: root, encoding: "utf8" }).stdout;
  assert.match(branches, /auto\/capability-/);

  const after = readProposals(w).items.find((p) => p.id === "p3");
  assert.equal(after.state, "patch_ready");
  assert.ok(after.patchCommit);
});
