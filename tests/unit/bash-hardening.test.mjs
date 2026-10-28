// bash 加固：受保护路径 / 只读模式 / 危险模式扩表（2026-10-28）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DANGEROUS_CMD_RE, USER_DENY_PATTERNS } from "../../engine/tools/security.mjs";
import { allowInReadOnly, readOnlyOn, setReadOnly } from "../../engine/tools/readonly-mode.mjs";
import { protectedHit } from "../../engine/tools/unified-tools.mjs";

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "harden-"));

test("危险模式扩表：换命令干同类事也要拦", () => {
  const bad = [
    "rm -rf /tmp/x",
    "find . -delete",
    "truncate -s 0 a.log",
    "shred -u a.txt",
    'powershell -c "Remove-Item -Recurse -Force D:\\tmp"',
    "cmd /c del /s C:\\tmp",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
  ];
  for (const c of bad) assert.ok(DANGEROUS_CMD_RE.test(c), `没拦住: ${c}`);
});

test("危险模式不误伤：普通读命令不能拦", () => {
  const ok = ["git status", "ls -la", "grep -n foo a.txt", "node scripts/x.mjs", "python script.py", "cat README.md"];
  for (const c of ok) assert.ok(!DANGEROUS_CMD_RE.test(c), `误伤: ${c}`);
});

test("受保护路径：bash 也能识别（补上 write 会拦、bash 不拦的洞）", () => {
  assert.equal(protectedHit("echo x > D:/pi-workspace/记忆/工作记忆.md"), "D:/pi-workspace/记忆/工作记忆.md");
  assert.equal(protectedHit("cat .token"), ".token");
  assert.match(protectedHit("python -c 'print(1)' 宪法.json"), /宪法/);
  assert.equal(protectedHit("git status"), "");
  assert.equal(protectedHit("node scripts/build.mjs"), "");
});

test("只读模式：默认关；开了只允许读命令", () => {
  const root = ws();
  assert.equal(readOnlyOn(root).on, false);

  assert.equal(allowInReadOnly("git status").ok, true);
  assert.equal(allowInReadOnly("grep -rn foo src/").ok, true);
  assert.equal(allowInReadOnly("rm -rf build").ok, false);
  assert.equal(allowInReadOnly("echo hi > a.txt").ok, false);
  assert.equal(allowInReadOnly("git commit -m x").ok, false);
  assert.equal(allowInReadOnly("npm install").ok, false);

  setReadOnly(root, true);
  assert.equal(readOnlyOn(root).on, true);
  setReadOnly(root, false);
  assert.equal(readOnlyOn(root).on, false);
});

test("只读模式：复合命令里夹一个写操作也要拒", () => {
  assert.equal(allowInReadOnly("git status && rm -rf build").ok, false);
  assert.equal(allowInReadOnly("cat a.txt | grep x").ok, true);
});
