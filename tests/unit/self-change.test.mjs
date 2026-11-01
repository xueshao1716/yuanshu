// L2 自改边界：白名单/上限/黑白名单/交付门 GREEN 才准入（2026-11-02）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkChange, makeProposal, recordProposal, listProposals, POLICY } from "../../engine/self-change.mjs";

const ok = { files: ["engine/foo.mjs"], verdict: "GREEN", reason: "诊断到漏判", hypothesis: "加一个校验" };

test("允许目录内、GREEN → 通过", () => {
  const r = makeProposal(ok);
  assert.equal(r.ok, true);
  assert.equal(r.proposal.files[0], "engine/foo.mjs");
  assert.match(r.proposal.branch, /^auto\//);
});

test("核心文件永远不许改", () => {
  for (const f of ["server.mjs", "package.json", "记忆/行动权清单.md", "APPEND_SYSTEM.md"]) {
    const r = checkChange({ files: [f] });
    assert.equal(r.ok, false, f);
    assert.ok(r.errors.some((e) => e.includes("不允许改")), f);
  }
});

test("不在白名单的目录被拒", () => {
  const r = checkChange({ files: ["docs/readme.md"] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("不在允许目录")));
});

test("文件数超上限被拒", () => {
  const files = Array.from({ length: POLICY.maxFiles + 1 }, (_, i) => `engine/f${i}.mjs`);
  assert.equal(checkChange({ files }).ok, false);
});

test("没有 GREEN 判决 → 不进面板", () => {
  for (const v of ["", "YELLOW", "RED"]) {
    const r = makeProposal({ ...ok, verdict: v });
    assert.equal(r.ok, false, v);
    assert.ok(r.errors.some((e) => e.includes("GREEN")));
  }
});

test("缺原因/假设被拒", () => {
  assert.equal(makeProposal({ ...ok, reason: "" }).ok, false);
  assert.equal(makeProposal({ ...ok, hypothesis: "" }).ok, false);
});

test("台账：写入后能按倒序读回", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selfchg-"));
  const a = makeProposal(ok).proposal;
  const b = makeProposal({ ...ok, reason: "第二次" }).proposal;
  recordProposal(root, a);
  recordProposal(root, b);
  const list = listProposals(root);
  assert.equal(list.length, 2);
  assert.equal(list[0].reason, "第二次");
});

test("回滚说明必须写清（合并前不影响）", () => {
  const r = makeProposal(ok).proposal;
  assert.match(r.rollback, /丢弃该分支/);
});
