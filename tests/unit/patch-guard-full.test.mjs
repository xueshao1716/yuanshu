// 给护栏补一条"全量门禁真的会拦"的测试（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginPatch, verifyPatch } from "../../engine/patch-guard.mjs";

test("全量门禁：npm test 不过就回滚（不是只跑新测试）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-full-"));
  fs.mkdirSync(path.join(root, "engine"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "unit"), { recursive: true });
  fs.writeFileSync(path.join(root, "engine", "a.mjs"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "tests", "unit", "red.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => { assert.equal(1, 2); });\n', "utf8");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test tests/unit/*.test.mjs" } }), "utf8");

  const s = beginPatch({ repoRoot: root, plan: { files: ["engine/a.mjs"] }, wsRoot: path.join(root, "ws"), files: ["engine/a.mjs"] }).session;
  fs.writeFileSync(path.join(root, "engine", "a.mjs"), "export const a = 2;\n", "utf8");

  const out = verifyPatch({ session: s, full: true, timeoutMs: 300000 });
  assert.equal(out.ok, false);
  assert.equal(out.rolledBack, true);
  assert.equal(fs.readFileSync(path.join(root, "engine", "a.mjs"), "utf8"), "export const a = 1;\n");
});
