#!/usr/bin/env node
// ===== scripts/forget-scan.mjs —— 遗忘扫描 CLI（手动，不接任何自动流程）=====
//
// 用法（2026-11-13 改为「归档优先于删除」）：
//   node scripts/forget-scan.mjs                          # 默认 dry-run：只报告，不写盘
//   node scripts/forget-scan.mjs --apply                  # 归档 cleanable + archive 两类（不删任何东西）
//   node scripts/forget-scan.mjs --apply --purge --yes    # 唯一会物理删除的路径：先全量备份，再删 cleanable
//   node scripts/forget-scan.mjs --restore <memory_id>    # 把误归档的 sqlite 记忆救回来（archived → active）
//   可选：--root <工作区>  --days <超时天数>  --top <条数>  --json  --no-sqlite
//
// 开关矩阵：
//   dry-run（默认）      只报告，零写盘
//   --apply              默认执行 = 归档；cleanable/archive 一律 status='archived' 或移进 记忆/归档/
//   --apply --purge      真删 cleanable（archive 类仍只归档）；必须再加 --yes
//   --apply --purge --yes 才真的删；删除前备份到 backups/Forget-<时间戳>/，报告列清删了什么
//   --delete-cleanable   旧名，等同 --purge（同样要求 --apply + --yes）
//   --restore <id>       单独动作，可与其它开关无关
//
// 退出码：
//   0  全 keep / 只有 suggest / restore 成功
//   2  有 cleanable 或 archive（需要人看一眼；可接 CI）
//   1  参数错误或执行失败
//
// 安全：删除必须 **--apply + --purge + --yes** 三个同时给；少一个都只会归档/报告。
//       备份落在 <工作区>/backups/Forget-<时间戳>/。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  scanMemoryEntries,
  planForgetting,
  applyForgetting,
  exitCodeFor,
  THRESHOLDS,
  WEIGHTS,
} from "../engine/memory-forget.mjs";
import { ensureMemorySchema, restoreMemory, initMemoryDb, resetMemoryDb } from "../engine/memory/db.mjs";
import { defaultWorkspace } from "../engine/workspace-default.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 纯函数：参数 → 模式。测试直接调它，不用起子进程。 */
export function resolveMode(argv = []) {
  const has = (flag) => argv.includes(flag);
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (has("--restore")) {
    const id = valueOf("--restore");
    if (id === undefined || String(id).startsWith("--")) return { mode: "error", error: "--restore 后面必须跟 memory id" };
    return { mode: "restore", restoreId: String(id) };
  }
  const apply = has("--apply");
  // --purge 是唯一允许物理删除的开关；--delete-cleanable 保留为旧名（同样要求 --apply + --yes）
  const purge = has("--purge") || has("--delete-cleanable");
  const yes = has("--yes");
  // 默认就是 dry-run；显式 --dry-run 与执行开关互斥，避免"本想预览却漏看 --apply"的事故
  if (has("--dry-run") && (apply || purge)) {
    return { mode: "error", error: "--dry-run 与 --apply/--purge 互斥" };
  }
  if (purge && !apply) {
    return { mode: "error", error: "--purge 必须同时给 --apply（否则只算报告）" };
  }
  if (purge && !yes) {
    return { mode: "error", error: "物理删除需要显式再加 --yes（默认只归档，不删）" };
  }
  if (purge) return { mode: "delete", apply: true, deleteCleanable: true, purge: true };
  if (apply) return { mode: "apply", apply: true, deleteCleanable: false };
  return { mode: "dry-run", apply: false, deleteCleanable: false };
}

/**
 * 纯函数：归档优先的计划。--apply 默认执行时，cleanable 与 archive 一律当归档处理，
 * 不再存在"apply 顺手删一批"的默认路径；物理删除只留给 --purge --yes。
 */
export function archiveFirstPlan(plan = {}) {
  const archive = [...(plan.archive || []), ...(plan.cleanable || [])];
  return {
    ...plan,
    archive,
    cleanable: [],
    stats: { ...(plan.stats || {}), archive: archive.length, cleanable: 0 },
  };
}

/**
 * applyForgetting 只把 sqlite 行改成 status='archived'；归档时间/原因在这里补。
 * 旧库缺 archived_at / archive_reason 列时由 ensureMemorySchema 自动 ALTER（幂等）。
 * 补元数据失败不该回滚已完成的归档，所以只回报、不抛。
 */
export function stampArchivedMeta({ root, now = Date.now(), items = [] } = {}) {
  const sqliteItems = (items || []).filter((it) => it.kind === "sqlite");
  if (!sqliteItems.length) return { updated: 0, skipped: 0, error: "" };
  const dbFile = path.join(root, "memory", "memory.db");
  if (!fs.existsSync(dbFile)) return { updated: 0, skipped: sqliteItems.length, error: "memory.db 不存在" };
  let conn = null;
  try {
    conn = new DatabaseSync(dbFile);
    ensureMemorySchema(conn);
    const upd = conn.prepare(
      "UPDATE memories SET archived_at = COALESCE(archived_at, ?), archive_reason = COALESCE(archive_reason, ?) WHERE memory_id = ? AND status = 'archived'",
    );
    let updated = 0;
    let skipped = 0;
    for (const it of sqliteItems) {
      const id = String(it.id || "").replace(/^sqlite:/, "");
      const reason = `遗忘归档：${String(it.reason || "").trim()}`.slice(0, 200);
      try {
        const changes = upd.run(now, reason, id).changes || 0;
        if (changes > 0) updated += changes;
        else skipped += 1; // 行已不在 / 不是 archived：不假装补上了
      } catch { skipped += 1; }
    }
    return { updated, skipped, error: "" };
  } catch (e) {
    return { updated: 0, skipped: sqliteItems.length, error: String(e?.message || e) };
  } finally {
    try { conn?.close(); } catch { }
  }
}

/** 救回归档：archived → active（与 /api/memory/:id/restore、db.restoreMemory 同一实现）。 */
export function restoreFromArchive({ root, id } = {}) {
  const dbFile = path.join(root, "memory", "memory.db");
  if (!fs.existsSync(dbFile)) return { ok: false, error: "not_found" };
  try {
    resetMemoryDb();
    initMemoryDb(root);
    return restoreMemory(String(id));
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    resetMemoryDb();
  }
}

/** 纯函数：解析 CLI 参数（--key value / --flag）。 */
export function parseArgs(argv = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue }
    const key = a.slice(2);
    if (key === "apply" || key === "delete-cleanable" || key === "purge" || key === "yes" || key === "json" || key === "no-sqlite" || key === "help" || key === "dry-run") {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[key] = next; i += 1; }
    else out[key] = true;
  }
  return out;
}

function resolveRoot(args) {
  if (typeof args.root === "string" && args.root.trim()) return path.resolve(args.root);
  const fromEnv = String(process.env.YUANSHU_WORKSPACE || process.env.PI_WORKSPACE || "").trim();
  if (fromEnv) return path.resolve(fromEnv);
  try { return path.resolve(defaultWorkspace()); } catch { return process.cwd(); }
}

function fmt(n, digits = 3) {
  return Number(n).toFixed(digits);
}

function printPlan(scan, plan, { top = 10, root }) {
  const s = plan.stats;
  const lines = [];
  lines.push(`🧹 遗忘扫描 · 工作区 ${root}`);
  lines.push(`扫描 ${s.total} 条 ｜ keep ${s.keep} · suggest ${s.suggest} · cleanable ${s.cleanable} · archive ${s.archive}`);
  lines.push(`引用数据缺失 ${s.refsMissing} 条${s.refsMissing ? "（已降级为 年龄+importance，不给可清理结论）" : ""}${s.refsMissingPinned ? `；另有 ${s.refsMissingPinned} 条 PIN 条目无需引用数据` : ""}`);
  if (s.pinned) lines.push(`PIN/固定记忆保护 ${s.pinned} 条`);
  if (s.truncated) lines.push(`⚠️ 条目超过上限，已截断 ${s.truncated} 条`);
  lines.push("");
  lines.push(`记忆单位：${scan.sources.filter((x) => x.entries > 0).map((x) => `${x.file}=${x.unit}(${x.entries})`).join(" ｜ ")}`);
  if (scan.journal.available) {
    const cov = scan.journal.coverageStart ? new Date(scan.journal.coverageStart).toLocaleString("zh-CN", { hour12: false }) : "未知";
    lines.push(`引用台账：记忆/运行时/记忆召回.json（${scan.journal.tracked} 条，覆盖自 ${cov}）`);
  } else {
    lines.push("引用台账：未找到记忆/运行时/记忆召回.json —— md 条目全部降级");
  }
  for (const w of scan.warnings || []) lines.push(`⚠️ ${w}`);
  lines.push("");

  if (plan.cleanable.length) {
    lines.push(`前 ${Math.min(top, plan.cleanable.length)} 条 cleanable（分数低→高）：`);
    plan.cleanable.slice(0, top).forEach((it, i) => {
      lines.push(`  ${i + 1}. [${fmt(it.score)}] ${it.source} ｜ ${it.preview.slice(0, 46)}`);
      lines.push(`     ${it.reason}`);
    });
  } else {
    lines.push("cleanable：0 条。");
    // 没有 cleanable 时给"最接近"的几条，方便判断是阈值太紧还是真没有陈旧记忆
    const nearest = plan.suggest.slice(0, Math.min(3, plan.suggest.length));
    if (nearest.length) {
      lines.push("最接近 cleanable 的 3 条（仍是 suggest，不会动）：");
      nearest.forEach((it, i) => {
        lines.push(`  ${i + 1}. [${fmt(it.score)}] ${it.source} ｜ ${it.preview.slice(0, 46)}`);
        lines.push(`     ${it.reason}`);
      });
    }
  }
  if (plan.archive.length) {
    lines.push("");
    lines.push(`archive（可归档，共 ${plan.archive.length} 条）：`);
    plan.archive.slice(0, top).forEach((it, i) => {
      lines.push(`  ${i + 1}. [${fmt(it.score)}] ${it.source} ｜ ${it.preview.slice(0, 46)}`);
      lines.push(`     ${it.reason}`);
    });
  }
  lines.push("");
  lines.push("建议：");
  if (plan.cleanable.length || plan.archive.length) {
    lines.push("  · 先人工过一遍上面列表；确认后再 --apply（cleanable/archive 一律归档，不删）");
    if (plan.cleanable.length) lines.push("  · 真要物理删除 cleanable：--apply --purge --yes（先备份到 backups/Forget-<时间戳>/，报告列清删了什么）");
  } else {
    lines.push("  · 没有可归档项，无需动作。");
  }
  lines.push("  · 本工具默认 dry-run，不写盘；不接定时任务。");
  console.log(lines.join("\n"));
}

/** 纯函数（可测）：执行一次扫描/归档/删除/恢复，返回结构化结果，不打印。
 *  argv/root/now 都可注入，测试不用起子进程；main 只负责打印。 */
export function runForget({ argv = [], root = "", now = Date.now() } = {}) {
  const args = parseArgs(argv);
  const mode = resolveMode(argv);
  if (mode.mode === "error") return { code: 1, error: mode.error, mode, args, now };
  const ws = path.resolve(root || resolveRoot(args));

  if (mode.mode === "restore") {
    const restored = restoreFromArchive({ root: ws, id: mode.restoreId });
    return { code: restored.ok ? 0 : 1, mode, args, root: ws, now, restored };
  }

  const thresholds = { ...THRESHOLDS };
  if (args.days !== undefined) {
    const n = Number(args.days);
    if (!Number.isFinite(n) || n <= 0) return { code: 1, error: "--days 必须是正数", mode, args, root: ws, now };
    thresholds.staleDays = n;
  }

  const scan = scanMemoryEntries({ root: ws, now, includeSqlite: !args["no-sqlite"] });
  const plan = planForgetting(scan.entries, { now, thresholds, weights: WEIGHTS });

  if (mode.mode === "dry-run") return { code: exitCodeFor(plan), mode, args, root: ws, now, scan, plan };

  // 默认执行 = 归档：cleanable 也进归档（md 移进 记忆/归档/，sqlite status='archived'），绝不物理删除；
  // 只有 --purge --yes 才走 deleteCleanable，把 cleanable 真删（applyForgetting 内部先全量备份）。
  const planToApply = mode.deleteCleanable ? plan : archiveFirstPlan(plan);
  const result = applyForgetting(planToApply, { root: ws, now, dryRun: false, deleteCleanable: mode.deleteCleanable });
  // applyForgetting 只改 status；归档时间/原因在这里补（旧库缺列自动 ALTER）
  const meta = stampArchivedMeta({ root: ws, now, items: result.archivedItems });
  // 报告正文由 memory-forget.mjs 生成，里面仍写着"cleanable 只报告"的旧措辞；
  // 本次的执行口径在末尾补一行，审计时以实际行为为准。
  try {
    const line = mode.deleteCleanable
      ? "> 执行口径（CLI）：--purge —— cleanable 已物理删除（备份见上），archive 类仍只归档。"
      : "> 执行口径（CLI）：默认归档 —— cleanable 与 archive 都已归档，未物理删除。";
    fs.appendFileSync(result.reportPath, `\n${line}\n`, "utf8");
  } catch { }
  return { code: result.errors.length ? 1 : exitCodeFor(plan), mode, args, root: ws, now, scan, plan, result, meta };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help) {
    console.log("用法：node scripts/forget-scan.mjs [--root <工作区>] [--days N] [--top N] [--json] [--no-sqlite] [--apply [--purge --yes]] [--restore <memory_id>]");
    return 0;
  }

  const out = runForget({ argv });
  if (out.error) {
    console.error(`❌ ${out.error}`);
    return out.code;
  }
  const { root, now } = out;
  const top = args.top === undefined ? 10 : Math.max(1, Math.min(200, Number(args.top) || 10));

  // --restore：把误归档的记忆救回来（archived → active，记 restored_at）
  if (out.mode.mode === "restore") {
    const r = out.restored || {};
    if (args.json) {
      console.log(JSON.stringify({ root, mode: "restore", restored: r }, null, 2));
    } else if (r.ok) {
      console.log(`♻️ 已恢复 ${r.item.memory_id}（status=active，restored_at=${new Date(r.item.restored_at).toLocaleString("zh-CN", { hour12: false })}）`);
    } else {
      console.error(`❌ 恢复失败：${r.error}${r.status ? `（当前 status=${r.status}，只有 archived 才能恢复）` : ""}`);
    }
    return out.code;
  }

  const { scan, plan, result, meta } = out;
  const jsonPlan = () => ({
    root,
    mode: out.mode.mode,
    weights: plan.weights,
    thresholds: plan.thresholds,
    stats: plan.stats,
    sources: scan.sources,
    journal: scan.journal,
    cleanable: plan.cleanable,
    archive: plan.archive,
    suggest: plan.suggest.map(({ text, row, ...rest }) => rest),
    keep: plan.keep.map(({ text, row, ...rest }) => rest),
  });

  // dry-run：只报告，不调用任何写盘逻辑
  if (out.mode.mode === "dry-run") {
    if (args.json) {
      console.log(JSON.stringify(jsonPlan(), null, 2));
    } else {
      printPlan(scan, plan, { top, root });
      console.log(`\n🔒 DRY-RUN：未写任何文件。将归档 ${plan.archive.length + plan.cleanable.length} 条（cleanable 也归档，不删），将删除 0 条。`);
    }
    return out.code;
  }

  if (args.json) {
    console.log(JSON.stringify({ ...jsonPlan(), result, meta }, null, 2));
    return out.code;
  }

  printPlan(scan, plan, { top, root });
  console.log("");
  console.log(`📦 已归档 ${result.archived} 条 ｜ 已删除 ${result.deleted} 条 ｜ 跳过 ${result.skipped} 条`);
  console.log(out.mode.deleteCleanable
    ? "   模式：--purge（物理删除 cleanable；archive 类仍只归档）"
    : "   模式：默认归档（cleanable 也进归档，不物理删除）");
  if (meta && meta.error) console.error(`⚠️ 归档元数据补齐失败（不影响归档本身）：${meta.error}`);
  else if (meta && meta.updated) console.log(`   归档元数据：${meta.updated} 条 sqlite 行已补 archived_at / archive_reason`);
  if (result.archiveFiles.length) console.log(`   归档正文：${result.archiveFiles.join("、")}`);
  if (result.archived > 0) console.log(`   归档日志：${result.logPath}`);
  console.log(`   报告：${result.reportPath}`);
  if (result.deleted > 0) {
    console.log(`   删除前备份：${result.backupDir}`);
    console.log("   删除清单：deleted.jsonl（含被删原文，可人工还原）");
    for (const it of result.deletedItems) console.log(`   - 已删 [${fmt(it.score)}] ${it.source} ｜ ${it.preview.slice(0, 50)}`);
  }
  if (result.errors.length) {
    for (const e of result.errors) console.error(`❌ ${e}`);
    return 1;
  }
  return out.code;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`❌ 遗忘扫描失败：${e?.stack || e}`);
    process.exitCode = 1;
  });
}

export { main };
