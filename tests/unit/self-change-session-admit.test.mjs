// 自改写回链路：自证前置 + 准入后置（2026-11-08）
// 全程临时目录 + 注入 verify/admit/run：不碰真实仓库，也绝不真 git commit。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finishSession, wtPath } from "../../engine/self-change-session.mjs";
import { computeFilesetHash } from "../../engine/self-change-verify.mjs";
import { admit, listAdmissions } from "../../engine/self-change-admit.mjs";
import { applyChange } from "../../engine/self-change-apply.mjs";

const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "selfsess-admit-"));
const okExec = () => ({ ok: true, code: 0, out: "", err: "" });

const seedWorktree = (root, id, files) => {
  const dir = wtPath(root, id);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
};

// 只模拟会话自己的 git（status / worktree remove / prune / branch -D）。
const sessionExec = (dir, status) => async (cmd, args) => {
  if (args[0] === "status") return { ok: true, code: 0, out: status, err: "" };
  if (args[0] === "worktree" && args[1] === "remove") {
    fs.rmSync(dir, { recursive: true, force: true });
    return okExec();
  }
  return okExec();
};

// 只模拟准入闸需要的 git（status / add / commit / rev-parse）。
const admitRun = (log = [], status = " M engine/demo.mjs\n") => async (cmd, args) => {
  log.push(args.join(" "));
  if (args.includes("status")) return { ok: true, code: 0, stdout: status, stderr: "" };
  if (args.includes("add")) return { ok: true, code: 0, stdout: "", stderr: "" };
  if (args.includes("commit")) return { ok: true, code: 0, stdout: "[main abc1234] 自证通过\n", stderr: "" };
  if (args.includes("rev-parse")) return { ok: true, code: 0, stdout: "abc1234deadbeef\n", stderr: "" };
  return { ok: true, code: 0, stdout: "", stderr: "" };
};

const passingSteps = [
  { name: "syntax", ok: true, ms: 1 },
  { name: "import", ok: true, ms: 1 },
  { name: "tests", ok: true, ms: 1 },
  { name: "deps", ok: true, ms: 1 },
];

test("finish：自证失败 → 不写回主树、worktree 分支保留、stage=verify", async () => {
  const root = mkRoot();
  const id = "v1";
  const content = "export const demo = 2;\n";
  const dir = seedWorktree(root, id, { "engine/demo.mjs": content });
  const exec = sessionExec(dir, " M engine/demo.mjs\n");
  let applied = false;
  let verifyArgs = null;
  const verify = async ({ repoRoot, files }) => {
    verifyArgs = { repoRoot, files };
    return {
      ok: false,
      filesetHash: "hash-v1",
      files,
      steps: [{ name: "syntax", ok: true, ms: 1 }, { name: "tests", ok: false, ms: 2, detail: "node --test 失败" }],
      reason: "自证未过：tests 失败",
    };
  };

  const r = await finishSession({
    wsRoot: root, id, exec, verify,
    apply: async () => { applied = true; return { ok: true } },
  });

  assert.equal(r.ok, false);
  assert.equal(r.stage, "verify");
  assert.equal(r.failedStep, "tests");
  assert.equal(r.filesetHash, "hash-v1");
  assert.equal(verifyArgs.repoRoot, dir, "自证必须跑在 worktree 里");
  assert.deepEqual(verifyArgs.files, ["engine/demo.mjs"]);
  assert.equal(applied, false, "自证不过绝不能写主树");
  assert.ok(fs.existsSync(dir), "worktree 必须留给诊断/继续改");
  assert.equal(r.worktree.dir, dir);
  assert.equal(r.worktree.branch, `auto/${id}`);
  assert.equal(r.worktree.exists, true);
  assert.equal(fs.existsSync(path.join(root, "engine/demo.mjs")), false, "主树不应出现文件");
});

test("finish：准入被拒（stale）→ 回滚写回、stage=admit + code、worktree 保留", async () => {
  const root = mkRoot();
  const id = "v2";
  const content = "export const demo = 3;\n";
  const dir = seedWorktree(root, id, { "engine/demo.mjs": content });
  const mainFile = path.join(root, "engine/demo.mjs");
  const exec = sessionExec(dir, " M engine/demo.mjs\n");
  // 有意给一个与写回后文件不符的 filesetHash：真准入闸必须判 stale
  const verify = async ({ files }) => ({
    ok: true, filesetHash: "stale-hash", files, steps: passingSteps, reason: "自证通过",
  });

  const r = await finishSession({
    wsRoot: root, id, exec, verify,
    apply: ({ id: cid, edits }) => applyChange({ wsRoot: root, id: cid, edits }),
    run: async () => { throw new Error("准入闸应在动 git 之前就拒绝") },
  });

  assert.equal(r.ok, false);
  assert.equal(r.stage, "admit");
  assert.equal(r.code, "stale");
  assert.match(r.reason, /filesetHash/);
  assert.equal(r.filesetHash, "stale-hash");
  assert.equal(r.rolledBack.ok, true, "写回必须按备份回滚");
  assert.equal(fs.existsSync(mainFile), false, "主树应回到写回前");
  assert.ok(fs.existsSync(dir), "worktree 与分支必须保留");
  assert.equal(r.worktree.exists, true);
});

test("finish：自证 + 准入全过 → 写回 + commit（run 模拟 git，不真提交）", async () => {
  const root = mkRoot();
  const id = "v3";
  const content = "export const demo = 4;\n";
  const dir = seedWorktree(root, id, { "engine/demo.mjs": content });
  const files = ["engine/demo.mjs"];
  const hash = computeFilesetHash({ repoRoot: dir, files }).filesetHash;
  const exec = sessionExec(dir, " M engine/demo.mjs\n");
  const log = [];
  let admitArgs = null;

  const r = await finishSession({
    wsRoot: root, id, exec,
    verify: async ({ files: fsFiles }) => ({ ok: true, filesetHash: hash, files: fsFiles, steps: passingSteps, reason: "自证通过" }),
    admit: async (opts) => { admitArgs = opts; return admit(opts) },
    apply: ({ id: cid, edits }) => applyChange({ wsRoot: root, id: cid, edits }),
    run: admitRun(log),
    note: "单测注入 git",
  });

  assert.equal(r.ok, true);
  assert.equal(r.stage, "applied");
  assert.equal(r.filesetHash, hash);
  assert.equal(r.commit, "abc1234deadbeef");
  assert.equal(r.admission.ok, true);
  assert.equal(r.admission.pushed, false);
  assert.equal(admitArgs.repoRoot, root, "准入闸必须核对主树");
  assert.deepEqual(admitArgs.files, files);
  assert.equal(admitArgs.verdict.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "engine/demo.mjs"), "utf8"), content, "必须真的写回主树");
  assert.ok(log.some((l) => l.includes("add")), "应经过 git add");
  assert.ok(log.some((l) => l.includes("commit")), "应经过 git commit");
  assert.equal(fs.existsSync(dir), false, "成功收口后 worktree 清理");
});

test("finish：requireAdmission:false → 跳过 admit，但明确记录已跳过准入", async () => {
  const root = mkRoot();
  const id = "v4";
  const content = "export const demo = 5;\n";
  const dir = seedWorktree(root, id, { "engine/demo.mjs": content });
  const files = ["engine/demo.mjs"];
  const hash = computeFilesetHash({ repoRoot: dir, files }).filesetHash;
  const exec = sessionExec(dir, " M engine/demo.mjs\n");
  let admitted = false;

  const r = await finishSession({
    wsRoot: root, id, exec,
    verify: async ({ files: fsFiles }) => ({ ok: true, filesetHash: hash, files: fsFiles, steps: passingSteps, reason: "自证通过" }),
    apply: ({ id: cid, edits }) => applyChange({ wsRoot: root, id: cid, edits }),
    admit: async () => { admitted = true; return { ok: true, commit: "should-not-happen" } },
    requireAdmission: false,
  });

  assert.equal(admitted, false, "显式关闭后不得调用准入闸");
  assert.equal(r.ok, true);
  assert.equal(r.stage, "applied");
  assert.equal(r.admission.skipped, true);
  assert.equal(r.admission.code, "skipped");
  assert.match(r.notes.join(" "), /已跳过准入/);
  assert.equal(fs.existsSync(path.join(root, "engine/demo.mjs")), true, "写回仍要发生");
  assert.equal(listAdmissions(root).length, 0, "跳过时不得写准入账本");
});
