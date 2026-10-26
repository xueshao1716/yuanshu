// 动代码的护栏：范围限制 + 自动回滚（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowedFromPlan, assertAllowed, beginPatch, rollback, changedFiles, verifyPatch } from "../../engine/patch-guard.mjs";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  fs.mkdirSync(path.join(root, "engine"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "unit"), { recursive: true });
  fs.writeFileSync(path.join(root, "engine", "a.mjs"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, ".token"), "secret\n", "utf8");
  return root;
}

const PLAN = { files: ["engine/a.mjs", "tests/unit/"] };

test("计划范围外的文件一律拒绝（含路径逃逸与受保护文件）", () => {
  const root = repo();
  const allowed = allowedFromPlan(PLAN);
  assert.equal(assertAllowed(root, "engine/a.mjs", allowed).ok, true);
  assert.equal(assertAllowed(root, "tests/unit/x.test.mjs", allowed).ok, true, "目录前缀要放行");

  const outside = assertAllowed(root, "server.mjs", allowed);
  assert.equal(outside.ok, false);
  assert.match(outside.error, /不在计划范围内/);

  const token = assertAllowed(root, ".token", allowed);
  assert.equal(token.ok, false);
  assert.match(token.error, /受保护/);

  const escape = assertAllowed(root, "../evil.mjs", allowed);
  assert.equal(escape.ok, false);
});

test("快照 → 改动 → 回滚：改动被还原，新文件被删除，重复回滚不炸", () => {
  const root = repo();
  const started = beginPatch({ repoRoot: root, plan: PLAN, wsRoot: path.join(root, "ws"), files: ["engine/a.mjs", "tests/unit/new.test.mjs"] });
  assert.equal(started.ok, true, started.error);
  const s = started.session;

  fs.writeFileSync(path.join(root, "engine", "a.mjs"), "export const a = 999;\n", "utf8");
  fs.writeFileSync(path.join(root, "tests", "unit", "new.test.mjs"), "// 新文件\n", "utf8");
  assert.equal(changedFiles(s).length, 2);

  rollback(s);
  assert.equal(fs.readFileSync(path.join(root, "engine", "a.mjs"), "utf8"), "export const a = 1;\n");
  assert.equal(fs.existsSync(path.join(root, "tests", "unit", "new.test.mjs")), false, "新建的应被删掉");
  assert.equal(rollback(s).ok, true, "重复回滚应幂等");
});

test("范围外的文件想改 → 开启阶段就拒绝（防患于未然）", () => {
  const root = repo();
  const bad = beginPatch({ repoRoot: root, plan: PLAN, wsRoot: path.join(root, "ws"), files: ["server.mjs"] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不在计划范围内/);
});

test("测试不过 → 自动回滚并如实报错", () => {
  const root = repo();
  fs.writeFileSync(path.join(root, "tests", "unit", "fail.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("should fail", () => { assert.equal(1, 2); });\n', "utf8");
  const s = beginPatch({ repoRoot: root, plan: PLAN, wsRoot: path.join(root, "ws"), files: ["engine/a.mjs"] }).session;
  fs.writeFileSync(path.join(root, "engine", "a.mjs"), "export const a = 2;\n", "utf8");
  const out = verifyPatch({ session: s, testFile: path.join(root, "tests", "unit", "fail.test.mjs") });
  assert.equal(out.ok, false);
  assert.equal(out.rolledBack, true);
  assert.equal(fs.readFileSync(path.join(root, "engine", "a.mjs"), "utf8"), "export const a = 1;\n", "红测试必须把改动还原");
});

test("测试通过 → 保留改动并返回改了什么", () => {
  const root = repo();
  fs.writeFileSync(path.join(root, "tests", "unit", "pass.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => { assert.equal(1, 1); });\n', "utf8");
  const s = beginPatch({ repoRoot: root, plan: PLAN, wsRoot: path.join(root, "ws"), files: ["engine/a.mjs"] }).session;
  fs.writeFileSync(path.join(root, "engine", "a.mjs"), "export const a = 3;\n", "utf8");
  const out = verifyPatch({ session: s, testFile: path.join(root, "tests", "unit", "pass.test.mjs") });
  assert.equal(out.ok, true);
  assert.equal(out.rolledBack, false);
  assert.equal(fs.readFileSync(path.join(root, "engine", "a.mjs"), "utf8"), "export const a = 3;\n");
  assert.ok(out.changed.some((c) => c.rel === "engine/a.mjs" && c.kind === "modified"));
});
