// 合并冲突：结构化返回 + 不冲突时正常合并（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mergeBranch } from "../../engine/autopatch-branch.mjs";

const sh = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
const head = (cwd) => execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
  sh(root, ["init", "-q"]);
  sh(root, ["config", "user.email", "t@t"]);
  sh(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "a.txt"), "line1\nline2\n", "utf8");
  sh(root, ["add", "-A"]);
  sh(root, ["commit", "-qm", "init"]);
  return { root, base: head(root) }; // 默认分支可能是 master，动态取
}

test("冲突：返回 conflict:true + 冲突文件，并已 abort（工作树干净）", () => {
  const { root, base } = initRepo();
  sh(root, ["checkout", "-qb", "auto/capability-x"]);
  fs.writeFileSync(path.join(root, "a.txt"), "line1\nBRANCH\n", "utf8");
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "branch"]);
  sh(root, ["checkout", "-q", base]);
  fs.writeFileSync(path.join(root, "a.txt"), "line1\nMAIN\n", "utf8");
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "main-side"]);

  const out = mergeBranch(root, "auto/capability-x");
  assert.equal(out.ok, false);
  assert.equal(out.conflict, true);
  assert.deepEqual(out.files, ["a.txt"]);
  assert.match(out.error, /和现在的代码冲突/);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim(), "", "合并必须已中止");
  assert.ok(!fs.readFileSync(path.join(root, "a.txt"), "utf8").includes("<<<<<<<"));
});

test("不冲突：正常合并成功", () => {
  const { root, base } = initRepo();
  sh(root, ["checkout", "-qb", "auto/capability-y"]);
  fs.writeFileSync(path.join(root, "b.txt"), "new\n", "utf8");
  sh(root, ["add", "-A"]); sh(root, ["commit", "-qm", "branch"]);
  sh(root, ["checkout", "-q", base]);

  const out = mergeBranch(root, "auto/capability-y");
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(path.join(root, "b.txt")));
});
