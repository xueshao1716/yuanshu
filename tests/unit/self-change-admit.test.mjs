// 准入闸：自证记录 + 拒绝矩阵 + 只提交自证过的那套文件（2026-11-08）
// 全程注入 run：测试里绝不真的 git add/commit。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { admit, recordVerification, listVerifications, listAdmissions, listLedger, buildCommitMessage, MAX_RECORDS } from "../../engine/self-change-admit.mjs";
import { verifyChange, computeFilesetHash } from "../../engine/self-change-verify.mjs";

const mkRepo = (files = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-admit-"));
  for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
  return root;
};
const writeFile = (root, rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
};

const STEPS = [
  { name: "syntax", ok: true, ms: 1 },
  { name: "import", ok: true, ms: 1 },
  { name: "tests", ok: true, ms: 1 },
  { name: "deps", ok: true, ms: 1 },
];

const seed = (root, files, { at = Date.now(), ok = true, steps = STEPS, reason = ok ? "自证通过" : "自证未过：tests 失败" } = {}) => {
  const hash = computeFilesetHash({ repoRoot: root, files }).filesetHash;
  const out = recordVerification(root, { ok, files, filesetHash: hash, steps, reason }, { now: at });
  assert.equal(out.ok, true);
  return hash;
};

const mkGitRun = ({ status = "", commitOk = true, commitErr = "", commitHash = "abc1234deadbeef", log } = {}) => async (cmd, args) => {
  if (log) log.push(args);
  if (args.includes("status")) return { ok: true, code: 0, stdout: status, stderr: "" };
  if (args.includes("add")) return { ok: true, code: 0, stdout: "", stderr: "" };
  if (args.includes("commit")) {
    return commitOk
      ? { ok: true, code: 0, stdout: "[main abc1234] 自证通过\n", stderr: "" }
      : { ok: false, code: 1, stdout: "", stderr: commitErr };
  }
  if (args.includes("rev-parse")) return { ok: true, code: 0, stdout: `${commitHash}\n`, stderr: "" };
  return { ok: true, code: 0, stdout: "", stderr: "" };
};

const baseRepo = () => mkRepo({ "engine/demo.mjs": "export const demo = 1;\n" });

test("拒绝矩阵：没有自证记录 / 自证失败 / 过期 / 哈希不符 / 夹带 / 越界 / 受保护", async () => {
  // 没有记录
  {
    const root = baseRepo();
    const log = [];
    const r = await admit({ repoRoot: root, files: ["engine/demo.mjs"], run: mkGitRun({ log, status: " M engine/demo.mjs\n" }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, "no_record");
    assert.equal(log.length, 0, "没有记录时不能动 git");
  }
  // 自证失败
  {
    const root = baseRepo();
    seed(root, ["engine/demo.mjs"], { ok: false });
    const r = await admit({ repoRoot: root, files: ["engine/demo.mjs"], run: mkGitRun({ status: " M engine/demo.mjs\n" }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, "verify_failed");
  }
  // 过期（31 分钟 > 30 分钟）
  {
    const root = baseRepo();
    seed(root, ["engine/demo.mjs"], { at: Date.now() - 31 * 60 * 1000 });
    const r = await admit({ repoRoot: root, files: ["engine/demo.mjs"], run: mkGitRun({ status: " M engine/demo.mjs\n" }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, "expired");
    assert.match(r.reason, /过期/);
  }
  // 自证之后又改过 → 哈希不符
  {
    const root = baseRepo();
    seed(root, ["engine/demo.mjs"]);
    writeFile(root, "engine/demo.mjs", "export const demo = 999;\n");
    const r = await admit({ repoRoot: root, files: ["engine/demo.mjs"], run: mkGitRun({ status: " M engine/demo.mjs\n" }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, "stale");
    assert.match(r.reason, /filesetHash/);
  }
  // 夹带无关改动
  {
    const root = baseRepo();
    seed(root, ["engine/demo.mjs"]);
    const r = await admit({ repoRoot: root, files: ["engine/demo.mjs"], run: mkGitRun({ status: " M engine/demo.mjs\n?? tmp-notes.txt\n" }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, "dirty");
    assert.match(r.reason, /tmp-notes\.txt/);
  }
  // 超出自改边界
  {
    const root = baseRepo();
    seed(root, ["engine/demo.mjs"]);
    const r = await admit({ repoRoot: root, files: ["server.mjs"], run: mkGitRun({ status: " M server.mjs\n" }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, "policy");
  }
  // 受保护文件（POLICY 白名单内、但 security 判受保护）
  {
    const root = baseRepo();
    const r = await admit({ repoRoot: root, files: ["frontend/src/人格定义.json"], run: mkGitRun({ status: "" }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, "denied");
  }
});

test("通过：只 add 这套文件、commit、返回 hash，默认不 push", async () => {
  const root = baseRepo();
  const hash = seed(root, ["engine/demo.mjs"]);
  const log = [];
  const r = await admit({
    repoRoot: root, files: ["engine/demo.mjs"], note: "补一条自证说明",
    run: mkGitRun({ log, status: " M engine/demo.mjs\n" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.commit, "abc1234deadbeef");
  assert.equal(r.pushed, false);
  assert.equal(r.filesetHash, hash);

  const add = log.find((a) => a.includes("add"));
  assert.deepEqual(add.slice(add.indexOf("--") + 1), ["engine/demo.mjs"]);
  const commit = log.find((a) => a.includes("commit"));
  const msg = commit[commit.indexOf("-m") + 1];
  assert.match(msg, /自证通过/);
  assert.match(msg, new RegExp(hash.slice(0, 12)));
  assert.match(msg, /补一条自证说明/);
  assert.ok(!log.some((a) => a.includes("push")), "默认不许 push");

  // 准入记录落盘
  const items = listAdmissions(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].commit, "abc1234deadbeef");
  const all = listLedger(root);
  assert.deepEqual(all.map((x) => x.kind).sort(), ["admit", "verify"]);
});

test("commit 失败（nothing to commit）→ no_changes，不写准入记录", async () => {
  const root = baseRepo();
  seed(root, ["engine/demo.mjs"]);
  const r = await admit({
    repoRoot: root, files: ["engine/demo.mjs"],
    run: mkGitRun({ status: "", commitOk: false, commitErr: "nothing to commit, working tree clean" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no_changes");
  assert.equal(listAdmissions(root).length, 0);
});

test("记录按文件集合匹配（与顺序无关）", async () => {
  const root = mkRepo({ "engine/a.mjs": "export const a = 1;\n", "engine/b.mjs": "export const b = 2;\n" });
  seed(root, ["engine/a.mjs", "engine/b.mjs"]);
  const r = await admit({
    repoRoot: root, files: ["engine/b.mjs", "engine/a.mjs"],
    run: mkGitRun({ status: " M engine/a.mjs\n M engine/b.mjs\n" }),
  });
  assert.equal(r.ok, true);
});

test("调用方另传 verdict：与当前文件不符则作废", async () => {
  const root = baseRepo();
  seed(root, ["engine/demo.mjs"]);
  const r = await admit({
    repoRoot: root, files: ["engine/demo.mjs"], verdict: { ok: true, filesetHash: "f".repeat(64) },
    run: mkGitRun({ status: " M engine/demo.mjs\n" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "stale");
});

test("端到端（注入 run）：verify → 落记录 → admit 成功 → 两份账本都落盘", async () => {
  const root = mkRepo({
    "engine/demo.mjs": "export const demo = 1;\n",
    "tests/unit/demo.test.mjs": "import { test } from 'node:test';\ntest('demo', () => {});\n",
  });
  const files = ["engine/demo.mjs", "tests/unit/demo.test.mjs"];
  const gitRun = mkGitRun({ status: " M engine/demo.mjs\n M tests/unit/demo.test.mjs\n" });
  const verifyRun = async (cmd, args) => {
    if (cmd === process.execPath && args[0] === "--check") return { ok: true, code: 0, stdout: "", stderr: "" };
    if (cmd === process.execPath && args[0] === "--test") return { ok: true, code: 0, stdout: "# pass 2", stderr: "" };
    return gitRun(cmd, args);
  };
  const verdict = await verifyChange({ repoRoot: root, files, run: verifyRun });
  assert.equal(verdict.ok, true);
  const rec = recordVerification(root, verdict);
  assert.equal(rec.ok, true);

  const out = await admit({ repoRoot: root, files, note: "端到端", run: gitRun });
  assert.equal(out.ok, true);
  assert.equal(out.commit, "abc1234deadbeef");

  const ledger = path.join(root, "记忆", "运行时");
  assert.ok(fs.existsSync(path.join(ledger, "自证记录.jsonl")));
  assert.ok(fs.existsSync(path.join(ledger, "准入记录.jsonl")));
  const verifyRec = listVerifications(root)[0];
  assert.equal(verifyRec.filesetHash, verdict.filesetHash);
  assert.deepEqual(verifyRec.files, [...files].sort());
});

test("自证记录只保留最近 200 条", async () => {
  const root = baseRepo();
  const file = path.join(root, "记忆", "运行时", "自证记录.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = Array.from({ length: 205 }, (_, i) => JSON.stringify({
    at: new Date(1_700_000_000_000 + i).toISOString(), filesetHash: "h" + i, files: ["engine/demo.mjs"], ok: true, steps: [],
  }));
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  seed(root, ["engine/demo.mjs"]);
  const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  assert.equal(MAX_RECORDS, 200);
  assert.equal(rows.length, 200);
  assert.equal(JSON.parse(rows[rows.length - 1]).reason, "自证通过");
});

test("buildCommitMessage：带自证摘要、无覆盖提示、note 与文件集指纹", () => {
  const msg = buildCommitMessage({
    files: ["engine/a.mjs"],
    filesetHash: "0123456789abcdef".repeat(4),
    steps: [{ name: "syntax", ok: true }, { name: "import", ok: true }, { name: "tests", ok: true, skipped: true }, { name: "deps", ok: true }],
    uncovered: ["engine/a.mjs"],
    note: "说明\n第二行",
    at: Date.parse("2026-11-08T14:00:00.000Z"),
  });
  assert.match(msg, /自证通过/);
  assert.match(msg, /syntax=ok import=ok tests=skipped deps=ok/);
  assert.match(msg, /无测试覆盖：engine\/a\.mjs/);
  assert.match(msg, /0123456789ab/);
  assert.match(msg, /Verified-Fileset: 0123456789ab/);
  assert.match(msg, /note: 说明 第二行/);
});
