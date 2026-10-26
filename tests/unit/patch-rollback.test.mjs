// 每一条失败路径都必须还原工作树（2026-10-26 事故复盘）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runProposal } from "../../engine/patch-runner.mjs";
import { refreshProposals, readProposals } from "../../engine/capability-proposal.mjs";

const REFINED = { refinement: { complete: true, samples: [{ text: "x" }], sites: [{ path: "engine/a.mjs", line: 1 }] } };

function repo({ withGit = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-"));
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

function proposalIn(ws, planPath, content = "export const a = 1;\n") {
  refreshProposals(ws, {});
  const data = readProposals(ws);
  fs.writeFileSync(planPath, "# t\n\n- `engine/a.mjs`\n", "utf8");
  data.items.push({
    id: "p1", state: "accepted", area: "shell", title: "t", symptom: "s",
    files: ["engine/a.mjs"], planPath, attempts: 0, plan: REFINED,
  });
  fs.writeFileSync(path.join(ws, "记忆", "运行时", "能力提案.json"), JSON.stringify(data), "utf8");
  return readProposals(ws).items.find((x) => x.id === "p1");
}

const ORIGINAL = "export const a = 1;\n";
// Windows 上 git checkout 还原会把行尾变成 CRLF，比较前先归一
const readNorm = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

test("建分支失败（不是 git 仓库）→ 必须还原工作树", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rb-ws-"));
  const root = repo({ withGit: false });                  // 没有 git → checkout -B 会失败
  const proposal = proposalIn(ws, path.join(ws, "PLAN.md"));
  const out = await runProposal({
    wsRoot: ws, repoRoot: root, proposal,
    generate: async () => ({ files: [{ path: "engine/a.mjs", content: "export const a = 999;\n" }] }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.stage, "branch");
  assert.equal(readNorm(path.join(root, "engine", "a.mjs")), ORIGINAL, "分支失败也必须还原");
});

test("门禁拦下 → 还原（这条原来就有，钉住防回归）", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rb-ws2-"));
  const root = repo();
  const proposal = proposalIn(ws, path.join(ws, "PLAN.md"));
  const out = await runProposal({
    wsRoot: ws, repoRoot: root, proposal,
    generate: async () => ({ files: [{ path: "engine/a.mjs", content: "const broken = (;\n" }] }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.stage, "gate");
  assert.equal(readNorm(path.join(root, "engine", "a.mjs")), ORIGINAL);
});

test("生成器抛异常 → 不留半截改动", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rb-ws3-"));
  const root = repo();
  const proposal = proposalIn(ws, path.join(ws, "PLAN.md"));
  let threw = false;
  try {
    await runProposal({ wsRoot: ws, repoRoot: root, proposal, generate: async () => { throw new Error("boom") } });
  } catch { threw = true }
  // 生成器在 beginPatch 之前就抛，不应该有任何改动
  assert.equal(readNorm(path.join(root, "engine", "a.mjs")), ORIGINAL);
  assert.ok(true, threw ? "异常向上抛也可以，但不能留下改动" : "异常被内部消化也可以");
});

test("成功后：改动在 auto 分支上，主线工作树干净", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rb-ws4-"));
  const root = repo();
  const proposal = proposalIn(ws, path.join(ws, "PLAN.md"));
  const out = await runProposal({
    wsRoot: ws, repoRoot: root, proposal,
    generate: async () => ({ files: [{ path: "engine/a.mjs", content: "export const a = 2;\n" }] }),
  });
  assert.equal(out.ok, true, out.error);
  const cur = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.equal(cur, "main");
  assert.equal(readNorm(path.join(root, "engine", "a.mjs")), ORIGINAL, "main 上不该留下改动");
  const show = spawnSync("git", ["show", `${out.branch}:engine/a.mjs`], { cwd: root, encoding: "utf8" }).stdout;
  assert.match(show, /a = 2/, "改动应该在 auto 分支上");
});
