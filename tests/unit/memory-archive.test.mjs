// 归档优先于删除契约（2026-11-13）：删错捞不回来，所以默认只归档。
// 覆盖：默认 --apply 只归档（sqlite 行还在 status=archived、md 移进 记忆/归档/）/
//       --purge 必须 --apply + --yes 才真删且先备份、报告列清删了什么 /
//       restore 能把 archived 救回 active 并记 restored_at / 旧库缺归档列自动 ALTER。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveMode, runForget } from "../../scripts/forget-scan.mjs";
import { memoryId } from "../../engine/recall-journal.mjs";

const DAY = 86400000;
// 固定"现在"：2026-11-09 12:00 本地时间，报告/归档文件名可断言
const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();

const CLEAN_MD = "### 2026-09-01 10:00\n- 久未引用的旧条目 cleanable-me";
const ARCHIVE_MD = "### 2026-01-02 00:00\n- 更旧的归档条目 archive-me";

function writeRel(root, rel, content) {
  const p = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

/**
 * 造一个"老工作区"：记忆日志两个块（cleanable / archive）+ 召回台账（让 md 有引用数据），
 * memory.db 用**旧 schema**（没有 archived_at / archive_reason 等列），两行分别落在两类。
 */
function seedWorkspace({ withDb = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ys-archive-"));
  writeRel(root, "记忆/记忆日志.md", `${CLEAN_MD}\n\n${ARCHIVE_MD}\n`);
  writeRel(root, "记忆/运行时/记忆召回.json", JSON.stringify({
    version: 1,
    pending: [],
    stats: {
      [memoryId("log", CLEAN_MD)]: { source: "log", text: CLEAN_MD, injected: 1, used: 0, lastInjectedAt: NOW - 60 * DAY, lastUsedAt: null },
    },
    recent: [{ at: NOW - 400 * DAY, query: "q", injected: 0, used: 0 }],
  }));
  if (withDb) {
    fs.mkdirSync(path.join(root, "memory"), { recursive: true });
    const db = new DatabaseSync(path.join(root, "memory", "memory.db"));
    db.exec(`CREATE TABLE memories (
      memory_id TEXT PRIMARY KEY, user_id TEXT, memory_type TEXT, summary TEXT,
      raw_content TEXT, vector_id TEXT, created_at INTEGER, updated_at INTEGER,
      importance_score REAL, expire_at INTEGER, source TEXT, access_count INTEGER,
      last_accessed_at INTEGER, status TEXT
    )`);
    const ins = db.prepare("INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    // archive 类：分数 < 0.15
    ins.run("m-arch", "owner", "fact", "sqlite 里的陈旧事实", null, null, NOW - 400 * DAY, NOW - 400 * DAY, 0.1, null, "auto", 0, null, "active");
    // cleanable 类：0.15 ≤ 分数 < 0.30，且 ≥30 天未引用
    ins.run("m-clean", "owner", "fact", "sqlite 里久未引用的条目", null, null, NOW - 100 * DAY, NOW - 100 * DAY, 0.4, null, "auto", 1, NOW - 60 * DAY, "active");
    db.close();
  }
  return root;
}

function readDb(root, sql) {
  const db = new DatabaseSync(path.join(root, "memory", "memory.db"), { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

function pragmaCols(root) {
  return readDb(root, "PRAGMA table_info(memories)").map((c) => c.name);
}

// ---------------------------------------------------------------------------
// 1. 默认 = 只归档
// ---------------------------------------------------------------------------

test("dry-run：不建归档目录、不建备份、行仍是 active", () => {
  const root = seedWorkspace();
  const out = runForget({ argv: [], root, now: NOW });
  assert.equal(out.code, 2);
  assert.equal(fs.existsSync(path.join(root, "记忆", "归档")), false);
  assert.equal(fs.existsSync(path.join(root, "backups")), false);
  assert.deepEqual(readDb(root, "SELECT status FROM memories WHERE memory_id = 'm-arch'").map((r) => r.status), ["active"]);
});

test("默认 --apply 只归档不删除：sqlite 行还在、status=archived、归档时间/原因已补", () => {
  const root = seedWorkspace();
  const out = runForget({ argv: ["--apply"], root, now: NOW });

  assert.equal(out.result.deleted, 0, "默认路径绝不能物理删除");
  assert.ok(out.result.archived >= 3, `cleanable + archive 都应归档，实际 ${out.result.archived}`);

  const rows = readDb(root, "SELECT memory_id, status, archived_at, archive_reason FROM memories ORDER BY memory_id");
  assert.deepEqual(rows.map((r) => r.memory_id), ["m-arch", "m-clean"], "行必须还在（只是归档）");
  for (const r of rows) {
    assert.equal(r.status, "archived");
    assert.ok(r.archived_at > 0, `${r.memory_id} 缺 archived_at`);
    assert.match(String(r.archive_reason), /^遗忘归档：/, `${r.memory_id} 缺归档原因`);
  }
  assert.equal(out.meta.updated, 2, "两条 sqlite 行的归档元数据都要补上");
  assert.equal(fs.existsSync(path.join(root, "backups")), false, "没有删除就不该有备份目录");
});

test("md 记忆默认进 记忆/归档/，源文件里被移走而不是删掉", () => {
  const root = seedWorkspace({ withDb: false });
  const out = runForget({ argv: ["--apply", "--no-sqlite"], root, now: NOW });

  const archiveFile = path.join(root, "记忆", "归档", "记忆日志-遗忘-2026-11-09.md");
  assert.ok(fs.existsSync(archiveFile), "md 条目要落进 记忆/归档/");
  const archived = fs.readFileSync(archiveFile, "utf8");
  assert.ok(archived.includes("cleanable-me"), "cleanable 的正文也要在归档里");
  assert.ok(archived.includes("archive-me"), "archive 的正文也要在归档里");

  const src = fs.readFileSync(path.join(root, "记忆", "记忆日志.md"), "utf8");
  assert.ok(!src.includes("cleanable-me"));
  assert.ok(!src.includes("archive-me"));
  assert.equal(out.result.deleted, 0, "md 默认是移动，不是删除");
  assert.ok(out.result.archiveFiles.some((f) => f.includes("记忆日志-遗忘-2026-11-09.md")));
});

// ---------------------------------------------------------------------------
// 2. --purge 才真删
// ---------------------------------------------------------------------------

test("开关矩阵：物理删除必须 --apply + --purge + --yes；--restore 单独生效", () => {
  assert.equal(resolveMode([]).mode, "dry-run");
  assert.equal(resolveMode(["--apply"]).mode, "apply");
  assert.equal(resolveMode(["--purge"]).mode, "error", "--purge 缺 --apply 只算报告");
  assert.equal(resolveMode(["--apply", "--purge"]).mode, "error", "--purge 缺 --yes 不许删");
  const purge = resolveMode(["--apply", "--purge", "--yes"]);
  assert.equal(purge.mode, "delete");
  assert.equal(purge.deleteCleanable, true);
  assert.equal(resolveMode(["--apply", "--delete-cleanable", "--yes"]).mode, "delete", "旧开关名仍然可用");
  assert.equal(resolveMode(["--dry-run", "--apply"]).mode, "error");
  assert.equal(resolveMode(["--restore"]).mode, "error", "--restore 必须给 id");
  const restore = resolveMode(["--restore", "m-arch"]);
  assert.equal(restore.mode, "restore");
  assert.equal(restore.restoreId, "m-arch");
});

test("--apply --purge --yes：cleanable 才真删，archive 仍只归档；先备份、报告列清删了什么", () => {
  const root = seedWorkspace();
  const out = runForget({ argv: ["--apply", "--purge", "--yes"], root, now: NOW });

  assert.ok(out.result.deleted >= 2, `cleanable 两类都要删，实际 ${out.result.deleted}`);
  const ids = readDb(root, "SELECT memory_id FROM memories ORDER BY memory_id").map((r) => r.memory_id);
  assert.deepEqual(ids, ["m-arch"], "cleanable 行被删，archive 行不该删");
  assert.equal(readDb(root, "SELECT status FROM memories WHERE memory_id = 'm-arch'")[0].status, "archived");

  // 删除前备份：整份清单 + 被删原文
  assert.ok(out.result.backupDir && fs.existsSync(out.result.backupDir), "删除前必须先备份");
  const manifest = fs.readFileSync(path.join(out.result.backupDir, "deleted.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(manifest.every((r) => r.mode === "delete"));
  assert.ok(manifest.some((r) => String(r.text).includes("cleanable-me")), "md 被删原文要能捞回");
  assert.ok(manifest.some((r) => String(r.text).includes("久未引用")), "sqlite 被删原文要能捞回");

  // 报告必须列清删了什么
  const report = fs.readFileSync(out.result.reportPath, "utf8");
  assert.match(report, /## 已删除（\d+）/);
  assert.ok(report.includes("cleanable-me"));
  assert.ok(out.result.deletedItems.length >= 2);
});

// ---------------------------------------------------------------------------
// 3. restore
// ---------------------------------------------------------------------------

test("restore 能救回：archived → active 并记 restored_at；非 archived 拒绝", () => {
  const root = seedWorkspace();
  runForget({ argv: ["--apply"], root, now: NOW });
  assert.equal(readDb(root, "SELECT status FROM memories WHERE memory_id = 'm-arch'")[0].status, "archived");

  const restored = runForget({ argv: ["--restore", "m-arch"], root, now: NOW });
  assert.equal(restored.code, 0);
  assert.equal(restored.restored.ok, true);
  assert.equal(restored.restored.item.status, "active");
  assert.ok(restored.restored.item.restored_at > 0, "要记 restored_at");
  assert.ok(restored.restored.item.archived_at > 0, "归档历史保留，仍可审计");

  const again = runForget({ argv: ["--restore", "m-arch"], root, now: NOW });
  assert.equal(again.code, 1);
  assert.equal(again.restored.error, "not_archived");

  const missing = runForget({ argv: ["--restore", "no-such-id"], root, now: NOW });
  assert.equal(missing.code, 1);
  assert.equal(missing.restored.error, "not_found");
});

// ---------------------------------------------------------------------------
// 4. 旧库兼容
// ---------------------------------------------------------------------------

test("旧库没有归档列：归档/恢复时自动 ALTER 补列，不炸", () => {
  const root = seedWorkspace();
  assert.ok(!pragmaCols(root).includes("archived_at"), "夹具必须是旧 schema");
  const out = runForget({ argv: ["--apply"], root, now: NOW });
  assert.equal(out.result.errors.length, 0);
  const cols = pragmaCols(root);
  for (const c of ["archived_at", "archive_reason", "restored_at", "card_text"]) {
    assert.ok(cols.includes(c), `旧库没有自动补上列：${c}`);
  }
});
