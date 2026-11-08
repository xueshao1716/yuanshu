// 隔离会话：建/收/弃，注入 exec 与 validate/apply 便于测试（2026-11-02）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSession, collectChanges, finishSession, abortSession, wtPath } from "../../engine/self-change-session.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "selfsess-"));
const fakeExec = (impl) => async (cmd, args, cwd) => impl(cmd, args, cwd);
const okExec = () => ({ ok: true, code: 0, out: "", err: "" });

test("start：已存在则拒", async () => {
  const root = ws();
  const exec = fakeExec((cmd, args) => { fs.mkdirSync(path.join(root, ".worktrees", "auto-s1"), { recursive: true }); return okExec() });
  const r = await startSession({ wsRoot: root, id: "s1", exec });
  assert.equal(r.ok, true);
  const again = await startSession({ wsRoot: root, id: "s1", exec });
  assert.equal(again.ok, false);
  assert.match(again.error, /已存在/);
});

test("collect：读到改动内容", async () => {
  const root = ws();
  const dir = wtPath(root, "s2");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "engine"), { recursive: true });
  fs.writeFileSync(path.join(dir, "engine/x.mjs"), "export const x = 1;\n");
  const exec = fakeExec((cmd, args) => (args[0] === "status" ? { ok: true, out: " M engine/x.mjs\n", err: "" } : okExec()));
  const r = await collectChanges({ wsRoot: root, id: "s2", exec });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, ["engine/x.mjs"]);
  assert.match(r.edits[0].content, /export const x/);
});

test("collect：改太多文件被拒", async () => {
  const root = ws();
  const dir = wtPath(root, "s3");
  fs.mkdirSync(dir, { recursive: true });
  const names = Array.from({ length: 6 }, (_, i) => `engine/f${i}.mjs`);
  fs.mkdirSync(path.join(dir, "engine"), { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), "x");
  const exec = fakeExec(() => ({ ok: true, out: names.map((n) => ` M ${n}`).join("\n"), err: "" }));
  const r = await collectChanges({ wsRoot: root, id: "s3", exec });
  assert.equal(r.ok, false);
  assert.match(r.error, /超过上限/);
});

test("finish：自证不过就不写主树，也不删工作区", async () => {
  const root = ws();
  const dir = wtPath(root, "s4");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "engine"), { recursive: true });
  fs.mkdirSync(path.join(dir, "engine"), { recursive: true });
  fs.writeFileSync(path.join(dir, "engine/x.mjs"), "new\n");
  const exec = fakeExec((cmd, args) => (args[0] === "status" ? { ok: true, out: " M engine/x.mjs\n", err: "" } : okExec()));
  let applied = false;
  const r = await finishSession({ wsRoot: root, id: "s4", exec, validate: async () => ({ ok: false, stage: "gate", errors: ["RED"] }), apply: async () => { applied = true; return { ok: true } } });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "gate");
  assert.equal(applied, false, "自证不过不能写");
  assert.ok(fs.existsSync(dir), "工作区应保留以便继续改");
});

test("finish：自证过 → 写入 → 清理工作区", async () => {
  const root = ws();
  const dir = wtPath(root, "s5");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "engine"), { recursive: true });
  fs.writeFileSync(path.join(dir, "engine/x.mjs"), "new\n");
  const exec = fakeExec((cmd, args) => {
    if (args[0] === "status") return { ok: true, out: " M engine/x.mjs\n", err: "" };
    if (args[0] === "worktree" && args[1] === "remove") { fs.rmSync(dir, { recursive: true, force: true }); return okExec() }
    return okExec();
  });
  let got = null;
  const r = await finishSession({
    wsRoot: root, id: "s5", exec,
    validate: async () => ({ ok: true, stage: "green" }),
    verify: async ({ files }) => ({ ok: true, filesetHash: "s5-hash", files, steps: [{ name: "deps", ok: true }], reason: "自证通过" }),
    admit: async () => ({ ok: true, commit: "c0ffee1" }),
    apply: async ({ edits }) => { got = edits; return { ok: true, backupDir: "/tmp/bak" } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.stage, "applied");
  assert.equal(got[0].path, "engine/x.mjs");
  assert.equal(fs.existsSync(dir), false, "工作区应删除");
});

test("abort：工作区被移除", async () => {
  const root = ws();
  const dir = wtPath(root, "s6");
  fs.mkdirSync(dir, { recursive: true });
  const exec = fakeExec((cmd, args) => { if (args[1] === "remove") fs.rmSync(dir, { recursive: true, force: true }); return okExec() });
  const r = await abortSession({ wsRoot: root, id: "s6", exec });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(dir), false);
});
