import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const mod = () => import("../../engine/ticket-worktree.mjs");
const GIT = "git";

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ys-wt-"));
  execFileSync(GIT, ["init", "-q", "-b", "main", dir]);
  execFileSync(GIT, ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync(GIT, ["-C", dir, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  execFileSync(GIT, ["-C", dir, "add", "."]);
  execFileSync(GIT, ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

test("开一棵工单树：目录建出来、分支是 agent/<id>，重复调用复用不报错", async () => {
  const { startTicketWorktree, worktreeDir, branchOf } = await mod();
  const repo = tempRepo();
  const r = startTicketWorktree(repo, "T-1");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.dir, worktreeDir(repo, "T-1"));
  assert.ok(fs.existsSync(path.join(r.dir, "a.txt")));
  const branches = execFileSync(GIT, ["-C", repo, "branch", "--list"], { encoding: "utf8" });
  assert.match(branches, new RegExp(branchOf("T-1").replace("/", "\\/")));

  const again = startTicketWorktree(repo, "T-1");
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
});

test("没改动就删树删分支；有改动就留着不硬删", async () => {
  const { startTicketWorktree, closeTicketWorktree, ticketWorktreeStatus, worktreeDir } = await mod();
  const repo = tempRepo();

  // 干净：删掉
  startTicketWorktree(repo, "T-clean");
  const clean = closeTicketWorktree(repo, "T-clean");
  assert.equal(clean.removed, true, clean.detail);
  assert.equal(fs.existsSync(worktreeDir(repo, "T-clean")), false);

  // 有改动：留着
  const { dir } = startTicketWorktree(repo, "T-dirty");
  fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
  assert.equal(ticketWorktreeStatus(repo, "T-dirty").dirty, true);
  const kept = closeTicketWorktree(repo, "T-dirty");
  assert.equal(kept.removed, false);
  assert.equal(kept.kept, true);
  assert.equal(kept.changed, 1);
  assert.ok(fs.existsSync(dir), "有改动的树不能删");
});

test("不存在的树：status 说没有，close 也不炸", async () => {
  const { ticketWorktreeStatus, closeTicketWorktree } = await mod();
  const repo = tempRepo();
  assert.deepEqual(ticketWorktreeStatus(repo, "nope"), { exists: false, dirty: false, changed: 0 });
  const r = closeTicketWorktree(repo, "nope");
  assert.equal(r.ok, true);
  assert.equal(r.removed, false);
});
