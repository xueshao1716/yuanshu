// memory-forget 契约（2026-11-09）
// 覆盖：打分单调 / PIN 加成 / 四类阈值边界 / 引用缺失降级 /
//       计划纯函数 / dry-run 零写盘 / apply 只归档 archive / 删除必须 flag+备份 /
//       归档日志与报告格式 / 扫描单位与引用匹配 / 退出码语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  computeTrustScore,
  classify,
  planForgetting,
  applyForgetting,
  exitCodeFor,
  scanMemoryEntries,
  splitMdEntries,
  WEIGHTS,
  THRESHOLDS,
} from "../../engine/memory-forget.mjs";
import { memoryId } from "../../engine/recall-journal.mjs";
import { resolveMode } from "../../scripts/forget-scan.mjs";

const DAY = 86400000;
// 固定"现在"：2026-11-09 12:00 本地时间，避免测试随运行日期漂移
const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();

function tmpRoot(prefix = "ys-forget-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRel(root, rel, content) {
  const p = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function walk(dir) {
  const out = [];
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(p);
    }
  };
  rec(dir);
  return out.sort();
}

function snapshot(dir) {
  return walk(dir).map((p) => {
    const st = fs.statSync(p);
    return `${path.relative(dir, p)}|${st.size}|${st.mtimeMs}`;
  });
}

// ---------------------------------------------------------------------------
// 1. 打分
// ---------------------------------------------------------------------------

test("打分单调：同引用条件下越老分数越低", () => {
  const common = { importance: 0.5, refCount: 2, lastRefAt: NOW - 5 * DAY };
  const young = computeTrustScore({ createdAt: NOW - 10 * DAY }, { now: NOW, ...common });
  const old = computeTrustScore({ createdAt: NOW - 100 * DAY }, { now: NOW, ...common });
  assert.equal(young.refsMissing, false);
  assert.equal(old.refsMissing, false);
  assert.ok(young.score > old.score, `young=${young.score} old=${old.score}`);
});

test("打分单调：引用越多分越高，且呈饱和曲线", () => {
  const mk = (refCount) => computeTrustScore(
    { createdAt: NOW - 30 * DAY },
    { now: NOW, importance: 0.5, refCount, lastRefAt: NOW - 3 * DAY },
  );
  const z = mk(0);
  const two = mk(2);
  const many = mk(20);
  assert.ok(two.score > z.score);
  assert.ok(many.score > two.score);
  // 饱和：0→2 的增量必须大于 2→20 的增量
  assert.ok((many.score - two.score) < (two.score - z.score));
});

test("PIN/PERMANENT 加 0.3，封顶 1", () => {
  const plain = computeTrustScore(
    { createdAt: NOW - 30 * DAY },
    { now: NOW, importance: 0.5, refCount: 1, lastRefAt: NOW - 3 * DAY },
  );
  const pinned = computeTrustScore(
    { createdAt: NOW - 30 * DAY, pinned: true },
    { now: NOW, importance: 0.5, refCount: 1, lastRefAt: NOW - 3 * DAY },
  );
  assert.ok(Math.abs((pinned.score - plain.score) - 0.3) < 0.002);
  const capped = computeTrustScore(
    { createdAt: NOW, pinned: true },
    { now: NOW, importance: 1, refCount: 50, lastRefAt: NOW },
  );
  assert.equal(capped.score, 1);
});

test("引用数据缺失：只降级用年龄+importance，并明确标 refsMissing", () => {
  const missing = computeTrustScore({ createdAt: NOW - 40 * DAY, importance: 0.5 }, { now: NOW });
  assert.equal(missing.refsMissing, true);
  assert.equal(missing.refCount, null);
  assert.equal(missing.daysSinceRef, null);

  // 显式 refsMissing 时，refCount 传 0 还是 99 都不能影响分数
  const a = computeTrustScore(
    { createdAt: NOW - 40 * DAY, importance: 0.5, refCount: 0, lastRefAt: null, refsMissing: true },
    { now: NOW },
  );
  const b = computeTrustScore(
    { createdAt: NOW - 40 * DAY, importance: 0.5, refCount: 99, lastRefAt: NOW, refsMissing: true },
    { now: NOW },
  );
  assert.equal(a.score, b.score);
  // 0.20/0.15 归一到 4/7、3/7：4/7*(1-40/120) + 3/7*0.5
  const expect = (4 / 7) * (1 - 40 / 120) + (3 / 7) * 0.5;
  assert.ok(Math.abs(a.score - expect) < 0.002, `got ${a.score}, expect≈${expect.toFixed(3)}`);
});

test("有引用计数但从未引用（0 次、lastRefAt=null）不算缺失", () => {
  const never = computeTrustScore(
    { createdAt: NOW - 40 * DAY, importance: 0.5, refCount: 0, lastRefAt: null },
    { now: NOW },
  );
  assert.equal(never.refsMissing, false);
  assert.equal(never.daysSinceRef, 40);
});

test("权重集中定义且可覆盖", () => {
  assert.equal(WEIGHTS.age + WEIGHTS.ref + WEIGHTS.recency + WEIGHTS.importance, 1);
  const base = computeTrustScore(
    { createdAt: NOW - 30 * DAY },
    { now: NOW, importance: 0.5, refCount: 2, lastRefAt: NOW - 3 * DAY },
  );
  const boosted = computeTrustScore(
    { createdAt: NOW - 30 * DAY },
    { now: NOW, importance: 0.5, refCount: 2, lastRefAt: NOW - 3 * DAY, weights: { ref: 0.8 } },
  );
  assert.notEqual(base.score, boosted.score);
});

// ---------------------------------------------------------------------------
// 2. 四分类阈值边界
// ---------------------------------------------------------------------------

test("四类阈值边界：keep=0.60 / cleanable=0.30 / archive=0.15", () => {
  const refs = { refCount: 1, daysSinceRef: 2, refsMissing: false };
  assert.equal(classify(0.6, refs), "keep");
  assert.equal(classify(0.599, refs), "suggest");
  assert.equal(classify(0.15, { refCount: 0, daysSinceRef: 60 }), "cleanable");
  assert.equal(classify(0.149, { refCount: 0, daysSinceRef: 60 }), "archive");
  assert.equal(classify(0.299, { refCount: 0, daysSinceRef: 30 }), "cleanable");
  assert.equal(classify(0.3, { refCount: 0, daysSinceRef: 30 }), "suggest");
  assert.equal(classify(0.299, { refCount: 0, daysSinceRef: 29 }), "suggest");
});

test("PIN 恒 keep；引用/年龄缺失时不给 cleanable/archive", () => {
  assert.equal(classify(0, { pinned: true }), "keep");
  assert.equal(classify(0, { refsMissing: true, daysSinceRef: 500 }), "suggest");
  assert.equal(classify(0, { ageMissing: true, refCount: 0, daysSinceRef: 500 }), "suggest");
});

test("阈值可集中覆盖", () => {
  assert.equal(classify(0.5, { refCount: 2, daysSinceRef: 2, thresholds: { keep: 0.4 } }), "keep");
  assert.equal(classify(0.35, { refCount: 0, daysSinceRef: 40, thresholds: { cleanable: 0.4 } }), "cleanable");
});

// ---------------------------------------------------------------------------
// 3. 计划（纯函数）
// ---------------------------------------------------------------------------

function fourKinds() {
  return [
    { id: "k", kind: "md", source: "记忆/记忆日志.md", createdAt: NOW - 2 * DAY, importance: 1, refCount: 5, lastRefAt: NOW - 1 * DAY, text: "K" },
    { id: "s", kind: "md", source: "记忆/记忆日志.md", createdAt: NOW - 2 * DAY, importance: 0.4, refCount: 0, lastRefAt: null, text: "S" },
    { id: "c", kind: "md", source: "记忆/记忆日志.md", createdAt: NOW - 60 * DAY, importance: 0.5, refCount: 0, lastRefAt: null, text: "C" },
    { id: "a", kind: "md", source: "记忆/记忆日志.md", createdAt: NOW - 300 * DAY, importance: 0, refCount: 0, lastRefAt: null, text: "A" },
  ];
}

test("planForgetting 四类分桶 + 统计", () => {
  const plan = planForgetting(fourKinds(), { now: NOW });
  assert.equal(plan.stats.total, 4);
  assert.equal(plan.stats.keep, 1);
  assert.equal(plan.stats.suggest, 1);
  assert.equal(plan.stats.cleanable, 1);
  assert.equal(plan.stats.archive, 1);
  assert.equal(plan.stats.refsMissing, 0);
  assert.equal(plan.keep[0].id, "k");
  assert.equal(plan.suggest[0].id, "s");
  assert.equal(plan.cleanable[0].id, "c");
  assert.equal(plan.archive[0].id, "a");
  // 只有危险类别携带全文，keep 不带（省内存，也避免误用）
  assert.equal(plan.cleanable[0].text, "C");
  assert.equal(plan.archive[0].text, "A");
  assert.equal(plan.keep[0].text, undefined);
  assert.ok(plan.cleanable[0].reason.includes("60 天未引用"));
});

test("planForgetting 不写盘、不改入参", () => {
  const root = tmpRoot();
  const file = writeRel(root, "记忆/记忆日志.md", "### 2026-01-01 00:00\n- x\n");
  const before = snapshot(root);
  const entries = fourKinds();
  const cloned = JSON.parse(JSON.stringify(entries));
  planForgetting(entries, { now: NOW });
  assert.deepEqual(snapshot(root), before, "计划阶段不得产生任何文件变化");
  assert.deepEqual(entries, cloned, "入参不得被修改");
  assert.ok(fs.existsSync(file));
});

test("planForgetting 支持 limits 截断", () => {
  const plan = planForgetting(fourKinds(), { now: NOW, limits: { maxEntries: 2 } });
  assert.equal(plan.stats.total, 2);
  assert.equal(plan.stats.truncated, 2);
});

// ---------------------------------------------------------------------------
// 4. dry-run / apply / delete
// ---------------------------------------------------------------------------

function twoBlockRoot() {
  const root = tmpRoot();
  writeRel(root, "记忆/记忆日志.md", [
    "### 2026-01-01 00:00",
    "- 这条该归档 archive-me",
    "",
    "### 2026-09-10 00:00",
    "- 这条可清理 cleanable-me",
    "",
  ].join("\n"));
  return root;
}

/** 扫描后用"引用数据可用、0 次引用"覆盖，构造可归档/可清理的稳定输入。 */
function scannedWithRefs(root) {
  const scan = scanMemoryEntries({ root, now: NOW, journal: false });
  return scan.entries.map((e) => ({
    ...e,
    refCount: 0,
    lastRefAt: null,
    refsMissing: false,
  }));
}

test("dry-run 绝不写盘：文件数与 mtime 都不变，连目录都不建", () => {
  const root = twoBlockRoot();
  const before = snapshot(root);
  const plan = planForgetting(scannedWithRefs(root), { now: NOW });
  assert.equal(plan.archive.length, 1);
  assert.equal(plan.cleanable.length, 1);

  const result = applyForgetting(plan, { root, now: NOW, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.archived, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.willArchive.length, 1);
  assert.equal(result.willDelete.length, 0);
  assert.deepEqual(snapshot(root), before, "dry-run 不允许任何文件变化");
  assert.equal(fs.existsSync(path.join(root, "记忆", "归档")), false);
  assert.equal(fs.existsSync(path.join(root, "backups")), false);
});

test("apply 只移动 archive 类，cleanable 原样留在源文件", () => {
  const root = twoBlockRoot();
  const plan = planForgetting(scannedWithRefs(root), { now: NOW });
  const result = applyForgetting(plan, { root, now: NOW, dryRun: false });

  assert.equal(result.archived, 1);
  assert.equal(result.deleted, 0);
  assert.equal(result.errors.length, 0);

  const src = fs.readFileSync(path.join(root, "记忆", "记忆日志.md"), "utf8");
  assert.ok(!src.includes("archive-me"), "archive 类应已移出热文件");
  assert.ok(src.includes("cleanable-me"), "cleanable 默认绝不动");

  const archiveFile = path.join(root, "记忆", "归档", "记忆日志-遗忘-2026-11-09.md");
  assert.ok(fs.existsSync(archiveFile), "归档正文应落到 记忆/归档/");
  assert.ok(fs.readFileSync(archiveFile, "utf8").includes("archive-me"));
  assert.equal(fs.existsSync(path.join(root, "backups")), false, "没有删除就不该有备份目录");
});

test("apply 的归档日志与报告格式可审计", () => {
  const root = twoBlockRoot();
  const plan = planForgetting(scannedWithRefs(root), { now: NOW });
  const result = applyForgetting(plan, { root, now: NOW, dryRun: false });

  assert.ok(fs.existsSync(result.logPath));
  const lines = fs.readFileSync(result.logPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  for (const key of ["at", "mode", "kind", "id", "source", "score", "reason", "preview", "textSha"]) {
    assert.ok(key in row, `归档日志缺少 ${key}`);
  }
  assert.equal(row.mode, "archive");
  assert.equal(row.source, "记忆/记忆日志.md");

  assert.ok(fs.existsSync(result.reportPath));
  const report = fs.readFileSync(result.reportPath, "utf8");
  assert.ok(report.includes("# 遗忘清理报告（2026-11-09）"));
  assert.ok(report.includes("## 已归档（1）"));
  assert.ok(report.includes("## 已删除（0）"));
  assert.ok(report.includes("archive-me"));
});

test("没有显式 deleteCleanable 时，cleanable 不会被删", () => {
  const root = twoBlockRoot();
  const plan = planForgetting(scannedWithRefs(root), { now: NOW });
  const result = applyForgetting(plan, { root, now: NOW, dryRun: false });
  assert.equal(result.deleted, 0);
  assert.ok(fs.readFileSync(path.join(root, "记忆", "记忆日志.md"), "utf8").includes("cleanable-me"));
});

test("deleteCleanable:true 才删 cleanable：先备份、再删、报告写清删了什么", () => {
  const root = tmpRoot();
  writeRel(root, "记忆/记忆日志.md", "### 2026-09-10 00:00\n- 这条可清理 cleanable-me\n");
  const plan = planForgetting(scannedWithRefs(root), { now: NOW });
  assert.equal(plan.cleanable.length, 1);
  assert.equal(plan.archive.length, 0);

  const result = applyForgetting(plan, { root, now: NOW, dryRun: false, deleteCleanable: true });
  assert.equal(result.deleted, 1);
  assert.equal(result.errors.length, 0);

  // 源文件里删掉了
  assert.ok(!fs.readFileSync(path.join(root, "记忆", "记忆日志.md"), "utf8").includes("cleanable-me"));

  // 备份目录 + 删除清单（含被删原文）
  assert.ok(result.backupDir && fs.existsSync(result.backupDir));
  const manifest = fs.readFileSync(path.join(result.backupDir, "deleted.jsonl"), "utf8").trim();
  const row = JSON.parse(manifest.split("\n")[0]);
  assert.equal(row.mode, "delete");
  assert.ok(row.text.includes("cleanable-me"));
  // 整文件备份也在
  assert.ok(fs.existsSync(path.join(result.backupDir, "记忆", "记忆日志.md")));

  // 报告必须写清删了什么
  const report = fs.readFileSync(result.reportPath, "utf8");
  assert.ok(report.includes("## 已删除（1）"));
  assert.ok(report.includes("cleanable-me"));
  assert.ok(report.includes("备份"));
});

test("计划后文件被改过 → 拒绝删除/移动（防误删）", () => {
  const root = tmpRoot();
  const file = writeRel(root, "记忆/记忆日志.md", "### 2026-01-01 00:00\n- 原本内容 archive-me\n");
  const plan = planForgetting(scannedWithRefs(root), { now: NOW });
  assert.equal(plan.archive.length, 1);

  fs.writeFileSync(file, "### 2026-01-01 00:00\n- 已经被人改过\n", "utf8");
  const result = applyForgetting(plan, { root, now: NOW, dryRun: false });

  assert.equal(result.archived, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.skipped, 1);
  assert.ok(result.skippedItems[0].reason.includes("内容已变化"));
  assert.ok(fs.readFileSync(file, "utf8").includes("已经被人改过"));
  assert.equal(fs.existsSync(path.join(root, "记忆", "归档")), false);
});

// ---------------------------------------------------------------------------
// 5. 退出码
// ---------------------------------------------------------------------------

test("退出码语义：cleanable/archive → 2；其余 → 0", () => {
  assert.equal(exitCodeFor({ keep: [], suggest: [], cleanable: [], archive: [] }), 0);
  assert.equal(exitCodeFor({ keep: [1], suggest: [1], cleanable: [], archive: [] }), 0);
  assert.equal(exitCodeFor({ cleanable: [{}], archive: [] }), 2);
  assert.equal(exitCodeFor({ cleanable: [], archive: [{}] }), 2);
});

test("CLI 模式：删除必须 --apply + --delete-cleanable + --yes 三开关", () => {
  assert.equal(resolveMode([]).mode, "dry-run");
  assert.equal(resolveMode(["--apply"]).mode, "apply");
  assert.equal(resolveMode(["--delete-cleanable"]).mode, "error");
  assert.equal(resolveMode(["--apply", "--delete-cleanable"]).mode, "error");
  assert.equal(resolveMode(["--apply", "--delete-cleanable", "--yes"]).mode, "delete");
  assert.equal(resolveMode(["--dry-run", "--apply"]).mode, "error");
  assert.equal(resolveMode(["--dry-run"]).mode, "dry-run");
});

// ---------------------------------------------------------------------------
// 6. 扫描单位与引用匹配
// ---------------------------------------------------------------------------

test("md 切分：一条 = 一个标题块；文件头说明区不参与", () => {
  const raw = [
    "# 记忆日志（文件头不参与）",
    "",
    "### 2026-10-01 10:00",
    "- 要点：一",
    "- status: superseded",
    "",
    "### 2026-10-02 10:00",
    "- 要点：二 PERMANENT",
    "",
  ].join("\n");
  const blocks = splitMdEntries(raw, "dated");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].startLine, 3);
  assert.equal(blocks[0].endLine, 5);
  assert.equal(blocks[1].startLine, 7);
});

test("扫描：日志/纠正/关系/固定记忆按各自单位切分并保护 PIN", () => {
  const root = tmpRoot();
  writeRel(root, "记忆/记忆日志.md", [
    "# 记忆日志",
    "",
    "### 2026-10-01 10:00",
    "- 要点：一",
    "- status: superseded",
    "",
    "### 2026-10-02 10:00",
    "- 要点：二 PERMANENT",
    "",
  ].join("\n"));
  writeRel(root, "记忆/关系记忆.md", "# 关系记忆\n\n> 说明\n\n## 称呼\n- 叫我小语（2026-10-13）\n");
  writeRel(root, "记忆.md", "# 固定记忆\n\n## 模型\n- 默认 deepseek（2026-10-01）\n");

  const scan = scanMemoryEntries({ root, now: NOW });
  const bySource = (s) => scan.entries.filter((e) => e.source === s);
  const logs = bySource("记忆/记忆日志.md");
  assert.equal(logs.length, 2);
  assert.equal(logs[0].superseded, true);
  assert.equal(logs[1].pinned, true);
  assert.equal(logs[1].type, "log");

  const rel = bySource("记忆/关系记忆.md");
  assert.equal(rel.length, 1);
  assert.equal(rel[0].pinned, true);
  assert.equal(rel[0].type, "relation");

  const fixed = bySource("记忆.md");
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].pinned, true);

  // id 稳定：再扫一次完全一致
  const again = scanMemoryEntries({ root, now: NOW });
  assert.deepEqual(again.entries.map((e) => e.id), scan.entries.map((e) => e.id));

  // 不扫的文件要写明原因
  assert.ok(scan.skipped.some((s) => s.file === "记忆/自我.md"));
});

test("扫描引用：命中台账 → 真计数；台账起点后未命中 → 0 次；起点前未命中 → refsMissing", () => {
  const root = tmpRoot();
  const aText = "### 2026-11-01 10:00\n- A";
  const bText = "### 2026-09-01 10:00\n- B";
  const cText = "### 2026-11-05 10:00\n- C";
  writeRel(root, "记忆/记忆日志.md", [aText, "", bText, "", cText, ""].join("\n"));

  const journal = {
    version: 1,
    stats: {
      [memoryId("log", aText)]: {
        source: "log", text: aText, injected: 6, used: 2,
        lastInjectedAt: NOW - 2 * DAY, lastUsedAt: NOW - 1 * DAY,
      },
    },
    pending: [],
    recent: [{ at: NOW - 10 * DAY, query: "q", injected: 1, used: 0 }],
  };
  writeRel(root, "记忆/运行时/记忆召回.json", JSON.stringify(journal));

  const scan = scanMemoryEntries({ root, now: NOW });
  const get = (p) => scan.entries.find((e) => e.text.includes(p));

  const a = get("- A");
  assert.equal(a.refsMissing, false);
  assert.equal(a.refCount, 6);
  assert.equal(a.lastRefAt, NOW - 1 * DAY, "取 max(lastInjectedAt, lastUsedAt)");
  assert.equal(a.refsFrom, "journal");

  const b = get("- B");
  assert.equal(b.refsMissing, true, "台账起点之前的条目不能假装引用为 0");
  assert.equal(b.refCount, null);

  const c = get("- C");
  assert.equal(c.refsMissing, false);
  assert.equal(c.refCount, 0);
  assert.equal(c.refsFrom, "journal-absence");

  assert.equal(scan.journal.available, true);
  assert.equal(scan.journal.coverageStart, NOW - 10 * DAY);
});

test("扫描 sqlite：一条记忆 = 一行，引用取 access_count / last_accessed_at", () => {
  const root = tmpRoot();
  const dir = path.join(root, "memory");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "memory.db"));
  db.exec(`CREATE TABLE memories (
    memory_id TEXT PRIMARY KEY, user_id TEXT, memory_type TEXT, summary TEXT,
    raw_content TEXT, vector_id TEXT, created_at INTEGER, updated_at INTEGER,
    importance_score REAL, expire_at INTEGER, source TEXT, access_count INTEGER,
    last_accessed_at INTEGER, status TEXT, last_confirmed_at INTEGER
  )`);
  db.prepare(`INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "m1", "owner", "preference", "伙伴偏好深色界面", null, null,
    NOW - 40 * DAY, NOW - 40 * DAY, 0.6, null, "manual", 3, NOW - 5 * DAY, "active", NOW - 40 * DAY,
  );
  db.close();

  const scan = scanMemoryEntries({ root, now: NOW });
  const row = scan.entries.find((e) => e.kind === "sqlite");
  assert.ok(row);
  assert.equal(row.id, "sqlite:m1");
  assert.equal(row.refCount, 3);
  assert.equal(row.lastRefAt, NOW - 5 * DAY);
  assert.equal(row.refsMissing, false);
  assert.equal(row.importance, 0.6);
  assert.equal(row.type, "preference");
  assert.equal(row.source, "memory/memory.db");
});

// ---------------------------------------------------------------------------
// 7. 安全性 / 参数
// ---------------------------------------------------------------------------

test("apply 拒绝操作工作区之外的文件", () => {
  const root = tmpRoot();
  const outside = path.join(tmpRoot("ys-forget-outside-"), "记忆/记忆日志.md");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, "### 2026-01-01 00:00\n- outside\n", "utf8");
  const plan = planForgetting([{
    id: "x", kind: "md", source: "记忆/记忆日志.md", file: outside,
    startLine: 1, endLine: 2, text: "### 2026-01-01 00:00\n- outside",
    createdAt: NOW - 300 * DAY, importance: 0, refCount: 0, lastRefAt: null, score: 0, action: "archive",
  }], { now: NOW });

  const result = applyForgetting(plan, { root, now: NOW, dryRun: false });
  assert.equal(result.archived, 0);
  assert.equal(result.skipped, 1);
  assert.ok(result.skippedItems[0].reason.includes("不在工作区"));
  assert.ok(fs.existsSync(outside), "工作区外的文件必须原样保留");
});

test("阈值默认值与源实现一致", () => {
  assert.equal(THRESHOLDS.staleDays, 30);
  assert.equal(THRESHOLDS.neverRefDays, 7);
  assert.equal(THRESHOLDS.keep, 0.6);
  assert.equal(THRESHOLDS.cleanable, 0.3);
  assert.equal(THRESHOLDS.archive, 0.15);
});
