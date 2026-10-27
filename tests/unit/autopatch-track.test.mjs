// 自动补丁收尾：状态判定 + 够不够格 + 默认不自动合并（2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describePatch, syncPatches, readConfig, readPatchState, patchLine, isMerged } from "../../engine/autopatch-track.mjs";

function gitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aptrack-"));
  const git = (...args) => execFileSync("git", ["-c", `safe.directory=${root.replace(/\\/g, "/")}`, ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  git("branch", "-M", "main");
  fs.writeFileSync(path.join(root, "a.mjs"), "// a\n", "utf8");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add a");
  return { root, git };
}

function makeBranch({ git, root: gitRepoRoot }, name, { files = 1, protectedFile = false } = {}) {
  git("checkout", "-q", "-b", name, "main");
  for (let i = 0; i < files; i += 1) {
    const f = protectedFile && i === 0 ? "记忆/工作记忆.md" : `patch-${i}.mjs`;
    const abs = path.join(gitRepoRoot, f);   // 必须写进临时仓库
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `// patch ${i}\n`, "utf8");
  }
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `patch ${name}`);
  git("checkout", "-q", "main");
}

test("默认配置不自动合并（红线：默认只提醒）", () => {
  const cfg = readConfig(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-")));
  assert.equal(cfg.autoMerge, false);
  assert.equal(cfg.maxAgeDays, 7);
});

test("分支状态：待合并 / 已合并", () => {
  const { root, git } = gitRepo();
  const cfg = { autoMerge: false, maxAgeDays: 7, maxFiles: 3 };
  makeBranch({ root, git }, "auto/capability-x");

  const before = describePatch(root, "auto/capability-x", { config: cfg });
  assert.equal(before.state, "awaiting_review");
  assert.equal(before.ready, false, "配置没开自动合并时永远不 ready");

  git("merge", "--no-ff", "-q", "-m", "merge", "auto/capability-x");
  const after = describePatch(root, "auto/capability-x", { config: cfg });
  assert.equal(after.state, "merged");
  assert.equal(isMerged(root, "auto/capability-x"), true);
});

test("改动过大 / 碰保护文件 → 不够格，且给出原因", () => {
  const { root, git } = gitRepo();
  const cfg = { autoMerge: true, maxAgeDays: 7, maxFiles: 2 };

  makeBranch({ root, git }, "auto/capability-big", { files: 4 });
  const big = describePatch(root, "auto/capability-big", { config: cfg });
  assert.equal(big.ready, false);
  assert.ok(big.reasons.some((r) => /文件过多/.test(r)), JSON.stringify(big.reasons));

  makeBranch({ root, git }, "auto/capability-prot", { files: 1, protectedFile: true });
  const prot = describePatch(root, "auto/capability-prot", { config: cfg });
  assert.equal(prot.ready, false);
  assert.ok(prot.reasons.some((r) => /保护文件/.test(r)), JSON.stringify(prot.reasons));
});

test("syncPatches 落状态文件；环境事实一行可读", () => {
  const { root, git } = gitRepo();
  makeBranch({ root, git }, "auto/capability-y");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));

  const out = syncPatches({ wsRoot: ws, repoRoot: root, doAutoMerge: false });
  assert.equal(out.awaiting, 1, JSON.stringify(out.patches));
  const state = readPatchState(ws);
  assert.ok(state.branches["auto/capability-y"]);

  const line = patchLine(ws);
  assert.match(line, /【自动补丁】/);
  assert.match(line, /auto\/capability-y/);
});

test("没有补丁时环境事实为空", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws2-"));
  assert.equal(patchLine(ws), "");
});
