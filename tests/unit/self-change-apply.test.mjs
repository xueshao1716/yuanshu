// 自改写入与回滚：备份、原子写、按盘还原（2026-11-02）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChange, rollbackChange, listBackups } from "../../engine/self-change-apply.mjs";

const ws = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selfapply-"));
  fs.mkdirSync(path.join(root, "engine"), { recursive: true });
  return root;
};

test("改之前先备份，改完内容正确", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "engine/a.mjs"), "old\n");
  const r = applyChange({ wsRoot: root, id: "c1", edits: [{ path: "engine/a.mjs", content: "new\n" }] });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "engine/a.mjs"), "utf8"), "new\n");
  assert.ok(fs.existsSync(path.join(r.backupDir, "manifest.json")));
  assert.equal(r.manifest.files[0].shaBefore.length, 16);
});

test("回滚还原原文", () => {
  const root = ws();
  const abs = path.join(root, "engine/a.mjs");
  fs.writeFileSync(abs, "old\n");
  applyChange({ wsRoot: root, id: "c2", edits: [{ path: "engine/a.mjs", content: "new\n" }] });
  const rb = rollbackChange({ wsRoot: root, id: "c2" });
  assert.equal(rb.ok, true);
  assert.equal(fs.readFileSync(abs, "utf8"), "old\n");
});

test("新建的文件回滚后应被删除", () => {
  const root = ws();
  const abs = path.join(root, "engine/brand-new.mjs");
  applyChange({ wsRoot: root, id: "c3", edits: [{ path: "engine/brand-new.mjs", content: "x\n" }] });
  assert.ok(fs.existsSync(abs));
  rollbackChange({ wsRoot: root, id: "c3" });
  assert.equal(fs.existsSync(abs), false);
});

test("白名单外的文件拒绝写入（不产生备份）", () => {
  const root = ws();
  const r = applyChange({ wsRoot: root, id: "c4", edits: [{ path: "server.mjs", content: "hack\n" }] });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "policy");
  assert.equal(fs.existsSync(path.join(root, "记忆", "运行时", "自改备份", "c4")), false);
});

test("没备份时回滚被拒（不瞎猜）", () => {
  const r = rollbackChange({ wsRoot: ws(), id: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有备份/);
});

test("备份列表：能看到且标出已回滚", () => {
  const root = ws();
  fs.writeFileSync(path.join(root, "engine/a.mjs"), "old\n");
  applyChange({ wsRoot: root, id: "c5", edits: [{ path: "engine/a.mjs", content: "new\n" }] });
  rollbackChange({ wsRoot: root, id: "c5" });
  const list = listBackups(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "c5");
  assert.equal(list[0].rolledBack, true);
});
