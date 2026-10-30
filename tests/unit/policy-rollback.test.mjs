// 策略历史回滚 + 路径条件的测试（2026-10-30）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globMatch, judgeAction } from "../../engine/tools/initiator.mjs";
import { readPolicy, writePolicy, rollbackPolicy, policyPath } from "../../engine/tools/policy-store.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "pol2-"));
const r1 = [{ id: "a-rule", initiator: ["scheduler"], deny: ["bash"], reason: "第一版" }];
const r2 = [{ id: "b-rule", initiator: ["scheduler"], deny: ["write"], reason: "第二版" }];

test("glob：双星跨目录，裸文件名也命中", () => {
  assert.equal(globMatch("**/.env", "a/b/.env"), true);
  assert.equal(globMatch("**/.env", ".env"), true);
  assert.equal(globMatch("**/.env", "a/b/x.txt"), false);
  assert.equal(globMatch("记忆/人格定义.json", "记忆/人格定义.json"), true);
});

test("规则加 paths：只拦这个路径", () => {
  const rule = { id: "no-env", initiator: ["scheduler"], deny: ["write"], paths: ["**/.env"], reason: "不许改 .env" };
  assert.equal(judgeAction({ tool: "write", args: { path: ".env" }, initiator: "scheduler", rules: [rule] }).allow, false);
  assert.equal(judgeAction({ tool: "write", args: { path: "a.md" }, initiator: "scheduler", rules: [rule] }).allow, true);
  assert.equal(judgeAction({ tool: "write", args: { path: ".env" }, initiator: "user", rules: [rule] }).allow, true);
});

test("写入两次后 history 里有上一版快照（带 id）", () => {
  const root = ws();
  writePolicy(root, r1);
  writePolicy(root, r2);
  const raw = JSON.parse(fs.readFileSync(policyPath(root), "utf8"));
  assert.ok(raw.history.length >= 1);
  assert.match(raw.history.at(-1).id, /^snap-/);
  assert.equal(raw.history.at(-1).rules[0].id, "a-rule");
});

test("回滚到上一版：规则回来，而且回滚本身也进历史", () => {
  const root = ws();
  writePolicy(root, r1);
  writePolicy(root, r2);
  const snap = JSON.parse(fs.readFileSync(policyPath(root), "utf8")).history.at(-1);
  const out = rollbackPolicy(root, snap.id);
  assert.equal(out.ok, true);
  assert.equal(readPolicy(root).rules[0].id, "a-rule");
  const raw = JSON.parse(fs.readFileSync(policyPath(root), "utf8"));
  assert.equal(raw.rules[0].id, "a-rule");
  assert.ok(raw.history.some((h) => h.rules[0].id === "b-rule"), "回滚前的规则要留档");
});

test("回滚到不存在的快照会说清楚", () => {
  const root = ws();
  writePolicy(root, r1);
  const out = rollbackPolicy(root, "snap-does-not-exist");
  assert.equal(out.ok, false);
  assert.match(out.error, /找不到|没有可回滚/);
});

test("没有历史时回滚给明确原因", () => {
  const root = ws();
  writePolicy(root, r1);
  assert.match(rollbackPolicy(root, "snap-0").error, /找不到|没有可回滚/);
});

test("paths 校验：必须是非空数组", () => {
  const root = ws();
  const out = writePolicy(root, [{ id: "bad-paths", initiator: ["scheduler"], deny: ["write"], paths: [] }]);
  assert.equal(out.ok, false);
  assert.match(out.error, /paths/);
});
