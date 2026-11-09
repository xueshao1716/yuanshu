#!/usr/bin/env node
// ===== scripts/forget-scan.mjs —— 遗忘扫描 CLI（手动，不接任何自动流程）=====
//
// 用法：
//   node scripts/forget-scan.mjs                          # 默认 dry-run：只报告，不写盘
//   node scripts/forget-scan.mjs --apply                  # 只归档 archive 类（cleanable 不动）
//   node scripts/forget-scan.mjs --apply --delete-cleanable --yes
//                                                         # 真删 cleanable：先备份，再删，报告写清删了什么
//   可选：--root <工作区>  --days <超时天数>  --top <条数>  --json  --no-sqlite
//
// 退出码：
//   0  全 keep / 只有 suggest
//   2  有 cleanable 或 archive（需要人看一眼；可接 CI）
//   1  参数错误或执行失败
//
// 安全：删除必须 **--apply + --delete-cleanable + --yes** 三个同时给；
//       少一个都只会报告。备份落在 <工作区>/backups/Forget-<时间戳>/。

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanMemoryEntries,
  planForgetting,
  applyForgetting,
  exitCodeFor,
  THRESHOLDS,
  WEIGHTS,
} from "../engine/memory-forget.mjs";
import { defaultWorkspace } from "../engine/workspace-default.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 纯函数：参数 → 模式。测试直接调它，不用起子进程。 */
export function resolveMode(argv = []) {
  const has = (flag) => argv.includes(flag);
  const apply = has("--apply");
  const del = has("--delete-cleanable");
  const yes = has("--yes");
  // 默认就是 dry-run；显式 --dry-run 与执行开关互斥，避免"本想预览却漏看 --apply"的事故
  if (has("--dry-run") && (apply || del)) {
    return { mode: "error", error: "--dry-run 与 --apply/--delete-cleanable 互斥" };
  }
  if (del && !apply) {
    return { mode: "error", error: "--delete-cleanable 必须同时给 --apply（否则只算报告）" };
  }
  if (del && !yes) {
    return { mode: "error", error: "真删 cleanable 需要显式再加 --yes（默认只报告，不删）" };
  }
  if (del && yes) return { mode: "delete", apply: true, deleteCleanable: true };
  if (apply) return { mode: "apply", apply: true, deleteCleanable: false };
  return { mode: "dry-run", apply: false, deleteCleanable: false };
}

/** 纯函数：解析 CLI 参数（--key value / --flag）。 */
export function parseArgs(argv = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue }
    const key = a.slice(2);
    if (key === "apply" || key === "delete-cleanable" || key === "yes" || key === "json" || key === "no-sqlite" || key === "help" || key === "dry-run") {
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
    lines.push("  · 先人工过一遍上面列表；确认后再 --apply（只归档 archive，cleanable 仍不动）");
    if (plan.cleanable.length) lines.push("  · 真要删 cleanable：--apply --delete-cleanable --yes（会先备份到 backups/Forget-<时间戳>/）");
  } else {
    lines.push("  · 没有可清理/可归档项，无需动作。");
  }
  lines.push("  · 本工具默认 dry-run，不写盘；不接定时任务。");
  console.log(lines.join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法：node scripts/forget-scan.mjs [--root <工作区>] [--days N] [--top N] [--json] [--no-sqlite] [--apply [--delete-cleanable --yes]]");
    return 0;
  }

  const mode = resolveMode(process.argv.slice(2));
  if (mode.mode === "error") {
    console.error(`❌ ${mode.error}`);
    return 1;
  }

  const root = resolveRoot(args);
  const now = Date.now();
  const thresholds = { ...THRESHOLDS };
  if (args.days !== undefined) {
    const n = Number(args.days);
    if (!Number.isFinite(n) || n <= 0) { console.error("❌ --days 必须是正数"); return 1 }
    thresholds.staleDays = n;
  }
  const top = args.top === undefined ? 10 : Math.max(1, Math.min(200, Number(args.top) || 10));

  const scan = scanMemoryEntries({ root, now, includeSqlite: !args["no-sqlite"] });
  const plan = planForgetting(scan.entries, { now, thresholds, weights: WEIGHTS });

  const jsonPlan = () => ({
    root,
    mode: mode.mode,
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
  if (mode.mode === "dry-run") {
    if (args.json) {
      console.log(JSON.stringify(jsonPlan(), null, 2));
    } else {
      printPlan(scan, plan, { top, root });
      console.log(`\n🔒 DRY-RUN：未写任何文件。将归档 ${plan.archive.length} 条，将删除 0 条（cleanable ${plan.cleanable.length} 条只报告）。`);
    }
    return exitCodeFor(plan);
  }

  const result = applyForgetting(plan, {
    root,
    now,
    dryRun: false,
    deleteCleanable: mode.deleteCleanable,
  });

  if (args.json) {
    console.log(JSON.stringify({ ...jsonPlan(), result }, null, 2));
    return result.errors.length ? 1 : exitCodeFor(plan);
  }

  printPlan(scan, plan, { top, root });
  console.log("");
  console.log(`📦 已归档 ${result.archived} 条 ｜ 已删除 ${result.deleted} 条 ｜ 跳过 ${result.skipped} 条`);
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
  return exitCodeFor(plan);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`❌ 遗忘扫描失败：${e?.stack || e}`);
    process.exitCode = 1;
  });
}

export { main };
