// 记忆 Git 版本化：能 diff、能回滚（抄 A5 的一条，2026-10-27）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitMemory, memoryHistory, rollbackMemory, memoryRepoDir } from "../../engine/memory-versioning.mjs";

function wsWith(content) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "memver-"));
  fs.mkdirSync(path.join(ws, "记忆"), { recursive: true });
  fs.writeFileSync(path.join(ws, "记忆.md"), content, "utf8");
  return ws;
}

test("第一次提交能建仓并落 commit；没有变化时不重复提交", () => {
  const ws = wsWith("# 记忆\n- 第一条\n");
  const a = commitMemory({ wsRoot: ws, message: "初始" });
  assert.equal(a.ok, true, a.reason);
  assert.equal(a.committed, true);
  assert.match(a.commit, /^[0-9a-f]{4,}$/);

  const b = commitMemory({ wsRoot: ws, message: "没有变化" });
  assert.equal(b.ok, true);
  assert.equal(b.committed, false);
  assert.equal(b.reason, "no_change");
});

test("历史按时间倒序可读", () => {
  const ws = wsWith("# 记忆\n- v1\n");
  commitMemory({ wsRoot: ws, message: "v1" });
  fs.writeFileSync(path.join(ws, "记忆.md"), "# 记忆\n- v2\n", "utf8");
  commitMemory({ wsRoot: ws, message: "v2" });

  const h = memoryHistory({ wsRoot: ws, limit: 5 });
  assert.equal(h.ok, true);
  assert.ok(h.items.length >= 2, "至少两次提交");
  assert.match(h.items[0].message, /v2/, "最新的在最前");
});

test("回滚能把内容恢复到旧版本，且回滚本身也留了快照", () => {
  const ws = wsWith("# 记忆\n- 原始\n");
  const first = commitMemory({ wsRoot: ws, message: "原始" });

  fs.writeFileSync(path.join(ws, "记忆.md"), "# 记忆\n- 被改坏了\n", "utf8");
  commitMemory({ wsRoot: ws, message: "改坏" });

  const rb = rollbackMemory({ wsRoot: ws, commit: first.commit });
  assert.equal(rb.ok, true, rb.error);
  assert.match(fs.readFileSync(path.join(ws, "记忆.md"), "utf8"), /原始/);

  const h = memoryHistory({ wsRoot: ws, limit: 5 });
  assert.ok(h.items.some((i) => /回滚到/.test(i.message)), "回滚要留痕");
});

test("不合法 commit 被拒（不误伤）", () => {
  const ws = wsWith("# 记忆\n");
  assert.equal(rollbackMemory({ wsRoot: ws, commit: "../../etc" }).ok, false);
  assert.equal(rollbackMemory({ wsRoot: ws, commit: "" }).ok, false);
});

test("独立 git-dir，不污染主仓；.bak 不入库", () => {
  const ws = wsWith("# 记忆\n");
  commitMemory({ wsRoot: ws, message: "x" });
  assert.ok(fs.existsSync(memoryRepoDir(ws)), "应有独立的 .memgit");
  assert.ok(!fs.existsSync(path.join(ws, ".git")), "不应在主仓位置建 .git");
  const exclude = fs.readFileSync(path.join(memoryRepoDir(ws), "info", "exclude"), "utf8");
  assert.match(exclude, /\*\.bak/);
});
