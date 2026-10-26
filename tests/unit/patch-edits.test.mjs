// 定点补丁的单测：唯一性、找不到、越界都要拦住（2026-10-26）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePatch, MAX_EDITS } from "../../engine/patch-generator.mjs";

function repoWith(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edits-"));
  fs.mkdirSync(path.join(root, "engine"), { recursive: true });
  fs.writeFileSync(path.join(root, "engine", "big.mjs"), body, "utf8");
  return root;
}

const PLAN = { files: ["engine/big.mjs"] };

test("定点补丁：find 唯一出现才放行（大文件不必整文件重写）", () => {
  const root = repoWith("const a = 1;\nconst b = 2;\n");
  const ok = validatePatch(root, PLAN, { edits: [{ path: "engine/big.mjs", find: "const a = 1;", replace: "const a = 10;" }] });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.edits.length, 1);
  assert.equal(ok.files.length, 0);
});

test("find 出现多次 → 整体拒绝（宁可不改，也不改错地方）", () => {
  const root = repoWith("x();\ny();\nx();\n");
  const bad = validatePatch(root, PLAN, { edits: [{ path: "engine/big.mjs", find: "x();", replace: "z();" }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /出现多次/);
});

test("find 找不到 → 拒绝（说明文件被改过或缩进不符）", () => {
  const root = repoWith("const a = 1;\n");
  const bad = validatePatch(root, PLAN, { edits: [{ path: "engine/big.mjs", find: "const a = 2;", replace: "x" }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /找不到 find/);
});

test("越界路径、过多改动点、空 find 都拒绝", () => {
  const root = repoWith("const a = 1;\n");
  assert.match(validatePatch(root, PLAN, { edits: [{ path: "server.mjs", find: "a", replace: "b" }] }).error, /不在计划范围内/);
  const many = Array.from({ length: MAX_EDITS + 1 }, () => ({ path: "engine/big.mjs", find: "const a = 1;", replace: "x" }));
  assert.match(validatePatch(root, PLAN, { edits: many }).error, /改动点太多/);
  assert.match(validatePatch(root, PLAN, { edits: [{ path: "engine/big.mjs", find: "  ", replace: "x" }] }).error, /find 为空/);
});

test("证据渲染不再是 [object Object]", async () => {
  const { buildPrompt } = await import("../../engine/patch-generator.mjs");
  const p = buildPrompt({ title: "t", files: ["engine/big.mjs"], evidence: [{ source: "feedback", id: "54ce2826-aaaa", at: Date.now() }] });
  assert.ok(!p.includes("[object Object]"), p.slice(0, 300));
  assert.match(p, /feedback · 54ce2826/);
});
