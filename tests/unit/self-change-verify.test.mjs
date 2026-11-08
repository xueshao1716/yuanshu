// 自证器：五步（syntax / import / tests / deps）+ filesetHash（2026-11-08）
// 纯逻辑 + 注入 run：测试里不真的跑 node/git，只验证"命令怎么发、结果怎么判"。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  verifyChange, computeFilesetHash, parsePorcelain, mapRelatedTests,
  assertCommandAllowed, resolveChangeFiles, normalizeFiles, isGateArtifact,
} from "../../engine/self-change-verify.mjs";

const mkRepo = (files = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-verify-"));
  for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
  return root;
};
const writeFile = (root, rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
};

// 注入执行器：按命令形状返回预设结果，并记录都发了哪些命令
const mkRun = ({ status = "", testCode = 0, checkStderr = {}, importStderr = "", log } = {}) => async (cmd, args) => {
  if (log) log.push([cmd, ...args]);
  if (cmd === process.execPath && args[0] === "--check") {
    const bad = checkStderr[args[1]];
    return bad ? { ok: false, code: 1, stdout: "", stderr: bad } : { ok: true, code: 0, stdout: "", stderr: "" };
  }
  if (cmd === process.execPath && args[0] === "--input-type=module") {
    return importStderr
      ? { ok: false, code: 1, stdout: "", stderr: importStderr }
      : { ok: true, code: 0, stdout: "", stderr: "" };
  }
  if (cmd === process.execPath && args[0] === "--test") {
    return testCode === 0
      ? { ok: true, code: 0, stdout: "# pass 2", stderr: "" }
      : { ok: false, code: testCode, stdout: "# fail 1", stderr: "not ok 1 - boom" };
  }
  if (args.includes("status")) return { ok: true, code: 0, stdout: status, stderr: "" };
  return { ok: true, code: 0, stdout: "", stderr: "" };
};

const okEngine = () => mkRepo({
  "engine/demo.mjs": "export const demo = 1;\n",
  "tests/unit/demo.test.mjs": "import { test } from 'node:test';\ntest('demo', () => {});\n",
});

test("四步全过：逐步记录 ok/ms，产出 sha256 filesetHash", async () => {
  const root = okEngine();
  const log = [];
  const r = await verifyChange({ repoRoot: root, files: ["engine/demo.mjs"], run: mkRun({ status: " M engine/demo.mjs\n", log }) });
  assert.equal(r.ok, true);
  assert.match(r.filesetHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.steps.map((s) => s.name), ["syntax", "import", "tests", "deps"]);
  for (const s of r.steps) {
    assert.equal(s.ok, true, `${s.name} 应通过`);
    assert.equal(typeof s.ms, "number");
    assert.ok(s.detail.length > 0);
  }
  assert.match(r.reason, /自证通过/);
  // 所有外部命令必须走注入的 run
  assert.ok(log.some((c) => c.includes("--check")), "应跑 node --check");
  assert.ok(log.some((c) => c.includes("--input-type=module")), "应跑 import 冒烟");
  assert.ok(log.some((c) => c.includes("--test")), "应跑 node --test");
  assert.ok(log.some((c) => c.includes("status") && c.includes("-uall")), "git status 要展开未跟踪目录，否则新目录对不上清单");
});

test("syntax：node --check 失败 → 该步失败，整体不通过", async () => {
  const root = okEngine();
  const r = await verifyChange({
    repoRoot: root, files: ["engine/demo.mjs"],
    run: mkRun({ status: " M engine/demo.mjs\n", checkStderr: { "engine/demo.mjs": "SyntaxError: Unexpected token }" } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((s) => s.name === "syntax").ok, false);
  assert.match(r.reason, /syntax/);
  assert.match(r.steps.find((s) => s.name === "syntax").detail, /SyntaxError/);
});

test("import：模块加载不起来（ERR_MODULE_NOT_FOUND）→ 该步失败，且跑在子进程里", async () => {
  const root = okEngine();
  const log = [];
  const r = await verifyChange({
    repoRoot: root, files: ["engine/demo.mjs"],
    run: mkRun({ status: " M engine/demo.mjs\n", log, importStderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'left-pad'" }),
  });
  assert.equal(r.ok, false);
  const step = r.steps.find((s) => s.name === "import");
  assert.equal(step.ok, false);
  assert.match(step.detail, /ERR_MODULE_NOT_FOUND/);
  assert.match(step.detail, /engine\/demo\.mjs/);
  assert.ok(log.some((c) => c.includes("--input-type=module")), "import 冒烟必须走注入的 run（子进程隔离）");
});

test("tests：相关测试跑不过 → 该步失败", async () => {
  const root = okEngine();
  const r = await verifyChange({ repoRoot: root, files: ["engine/demo.mjs"], run: mkRun({ status: " M engine/demo.mjs\n", testCode: 1 }) });
  assert.equal(r.ok, false);
  const step = r.steps.find((s) => s.name === "tests");
  assert.equal(step.ok, false);
  assert.match(step.detail, /退出码 1/);
});

test("tests：找不到相关测试 → 标 skipped 并明说无覆盖，整体仍可 ok", async () => {
  const root = mkRepo({ "engine/lonely.mjs": "export const lonely = 1;\n" });
  const r = await verifyChange({ repoRoot: root, files: ["engine/lonely.mjs"], run: mkRun({ status: " M engine/lonely.mjs\n" }) });
  const step = r.steps.find((s) => s.name === "tests");
  assert.equal(step.skipped, true);
  assert.equal(step.ok, true);
  assert.match(step.detail, /无测试覆盖/);
  assert.equal(r.ok, true, "无测试覆盖不假装失败，但必须在结果里说清楚");
  assert.match(r.reason, /无测试覆盖/);
  assert.deepEqual(r.evidence.uncovered, ["engine/lonely.mjs"]);
});

test("tests：按 base 前缀映射 tests/unit/foo*.test.mjs 与 tests/foo*.test.mjs", async () => {
  const root = mkRepo({
    "engine/foo.mjs": "export const foo = 1;\n",
    "tests/unit/foo.test.mjs": "",
    "tests/unit/foo-extra.test.mjs": "",
    "tests/foo-legacy.test.mjs": "",
  });
  const map = mapRelatedTests({ repoRoot: root, files: ["engine/foo.mjs"] });
  assert.deepEqual(map.targets, ["tests/foo-legacy.test.mjs", "tests/unit/foo-extra.test.mjs", "tests/unit/foo.test.mjs"]);
  assert.deepEqual(map.uncovered, []);

  const log = [];
  await verifyChange({ repoRoot: root, files: ["engine/foo.mjs"], run: mkRun({ status: " M engine/foo.mjs\n", log }) });
  const testCmd = log.find((c) => c.includes("--test"));
  assert.deepEqual(testCmd.slice(2), map.targets);
});

test("deps：git status 夹带无关改动 → 失败并列出文件", async () => {
  const root = okEngine();
  const r = await verifyChange({
    repoRoot: root, files: ["engine/demo.mjs"],
    run: mkRun({ status: " M engine/demo.mjs\n?? notes.txt\n M README.md\n" }),
  });
  assert.equal(r.ok, false);
  const step = r.steps.find((s) => s.name === "deps");
  assert.equal(step.ok, false);
  assert.deepEqual(step.foreign.sort(), ["README.md", "notes.txt"]);
  assert.deepEqual(r.evidence.git.foreign.sort(), ["README.md", "notes.txt"], "证据里也要能查");
  assert.match(step.detail, /夹带无关改动/);
  assert.match(r.reason, /deps/);
});

test("deps：只有本次改动（含重命名写法）→ 通过", async () => {
  const root = okEngine();
  const r = await verifyChange({
    repoRoot: root, files: ["engine/demo.mjs"],
    run: mkRun({ status: "R  engine/old.mjs -> engine/demo.mjs\n" }),
  });
  assert.equal(r.steps.find((s) => s.name === "deps").ok, true);
  assert.deepEqual(parsePorcelain("R  engine/old.mjs -> engine/demo.mjs\n"), ["engine/demo.mjs"]);
});

test("filesetHash：与文件顺序无关，内容变一个字节就作废", async () => {
  const root = mkRepo({ "engine/a.mjs": "export const a = 1;\n", "engine/b.mjs": "export const b = 2;\n" });
  const one = computeFilesetHash({ repoRoot: root, files: ["engine/a.mjs", "engine/b.mjs"] });
  const two = computeFilesetHash({ repoRoot: root, files: ["engine/b.mjs", "engine/a.mjs"] });
  assert.equal(one.filesetHash, two.filesetHash);
  writeFile(root, "engine/a.mjs", "export const a = 2;\n");
  const after = computeFilesetHash({ repoRoot: root, files: ["engine/a.mjs", "engine/b.mjs"] });
  assert.notEqual(after.filesetHash, one.filesetHash);
  assert.equal(after.filesetHash.length, 64);
});

test("全跳过（只有 git 洁净检查）不算自证：整体失败并说明", async () => {
  const root = mkRepo({ "frontend/src/Orphan.tsx": "export const Orphan = () => null;\n" });
  const r = await verifyChange({ repoRoot: root, files: ["frontend/src/Orphan.tsx"], run: mkRun({ status: " M frontend/src/Orphan.tsx\n" }) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps.filter((s) => s.skipped).map((s) => s.name), ["syntax", "import", "tests"]);
  assert.match(r.reason, /没有任何实质检查/);
});

test("非法路径与不存在文件：直接拒绝，不跑任何外部命令", async () => {
  const root = okEngine();
  const log = [];
  const bad = await verifyChange({ repoRoot: root, files: ["../escape.mjs"], run: mkRun({ log }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.steps[0].name, "files");
  assert.match(bad.reason, /越界/);

  const missing = await verifyChange({ repoRoot: root, files: ["engine/gone.mjs"], run: mkRun({ log }) });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /文件不存在/);
  assert.equal(log.length, 0, "被拒的请求不能发命令");
});

test("normalizeFiles：去重、排序、反斜杠归一", () => {
  const r = normalizeFiles(["engine\\b.mjs", "./engine/a.mjs", "engine/a.mjs"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, ["engine/a.mjs", "engine/b.mjs"]);
  assert.equal(normalizeFiles([]).ok, false);
  assert.equal(normalizeFiles(["engine/a.mjs\nrm -rf"]).ok, false, "控制字符一律拒绝");
});

test("assertCommandAllowed：git push -f 命中安全红线，普通命令放行", () => {
  const denied = assertCommandAllowed("git", ["push", "-f", "origin", "main"]);
  assert.equal(denied.ok, false);
  assert.equal(denied.rule, "no-force-git");
  assert.equal(assertCommandAllowed(process.execPath, ["--check", "engine/a.mjs"]).ok, true);
  assert.equal(assertCommandAllowed("git", ["commit", "-m", "自证通过"]).ok, true);
});

test("parsePorcelain：解码 git 对中文路径的八进制引号转义", () => {
  assert.deepEqual(parsePorcelain('?? "\\350\\256\\260\\345\\277\\206/"\n'), ["记忆/"]);
  assert.deepEqual(parsePorcelain("?? 记忆/运行时/自证记录.jsonl\n"), ["记忆/运行时/自证记录.jsonl"]);
  assert.equal(isGateArtifact("记忆/运行时/自证记录.jsonl"), true);
  assert.equal(isGateArtifact("engine/other.mjs"), false);
});

test("resolveChangeFiles：认工作区（.worktrees/auto-<id>）里的改动", async () => {
  const root = mkRepo();
  const wt = path.join(root, ".worktrees", "auto-s1");
  fs.mkdirSync(path.join(wt, "engine"), { recursive: true });
  fs.writeFileSync(path.join(wt, "engine/x.mjs"), "export const x = 1;\n", "utf8");
  const r = await resolveChangeFiles({
    repoRoot: root, changeId: "s1",
    run: async (cmd, args) => (args.includes("status") ? { ok: true, code: 0, stdout: " M engine/x.mjs\n", stderr: "" } : { ok: true, code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, "worktree");
  assert.equal(path.resolve(r.repoRoot), path.resolve(wt));
  assert.deepEqual(r.files, ["engine/x.mjs"]);
});
