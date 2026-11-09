#!/usr/bin/env node
// ===== scripts/vitality.mjs —— 机制产出新鲜度体检 CLI（2026-11-09）=====
//
// 用法：
//   node scripts/vitality.mjs                      # 只报告（表格式），默认工作区
//   node scripts/vitality.mjs --root D:\pi-workspace
//   node scripts/vitality.mjs --json               # 机器可读（审计明细 + 摘要）
//   node scripts/vitality.mjs --stale-days 1       # 全局把阈值临时改成 1 天（体检演练用）
//   node scripts/vitality.mjs --stale-days growth=90 --stale-days forget-report=7
//   node scripts/vitality.mjs --strict             # 无证据(unknown)也算挂，可接 CI
//
// 退出码：
//   0  没有 stale / never 项（unknown 不算，除非 --strict）
//   2  有 stale 或 never 项（可接 CI / 定时任务）
//   1  参数错误或执行失败
//
// 为什么 unknown 默认不判死：unknown 是"没有证据"，不是"有证据说它坏了"。
// 但假活恰恰最爱藏在 unknown 里（路径写错 → 全绿），所以 --strict 存在，
// 且非 strict 模式下摘要最后一句会主动点出"另有 N 项无证据"。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditVitality, summarize, stateLabel, formatTime, humanAge } from "../engine/vitality.mjs";
import { defaultWorkspace, existingWorkspace } from "../engine/workspace-default.mjs";

const DAY = 86400000;

/** 纯函数：参数 → 配置。测试直接调它，不用起子进程。 */
export function parseArgs(argv = []) {
  const cfg = {
    root: "", json: false, strict: false, help: false,
    thresholds: {}, error: "",
  };
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--json") { cfg.json = true; continue; }
    if (a === "--strict") { cfg.strict = true; continue; }
    if (a === "--help" || a === "-h") { cfg.help = true; continue; }
    if (a === "--root") {
      const v = args[i + 1];
      if (!v || v.startsWith("--")) { cfg.error = "--root 需要一个工作区路径"; return cfg; }
      cfg.root = v; i += 1; continue;
    }
    if (a === "--stale-days") {
      const v = args[i + 1];
      if (!v || v.startsWith("--")) { cfg.error = "--stale-days 需要天数（或 id=天数）"; return cfg; }
      i += 1;
      // 两种写法：`3` 全局覆盖；`growth=90` 只覆盖这一项
      const eq = v.indexOf("=");
      if (eq < 0) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) { cfg.error = `--stale-days 只收非负数字："${v}"`; return cfg; }
        cfg.thresholds.default = n * DAY;
      } else {
        const id = v.slice(0, eq).trim();
        const n = Number(v.slice(eq + 1));
        if (!id) { cfg.error = `--stale-days 的 id 不能为空："${v}"`; return cfg; }
        if (!Number.isFinite(n) || n < 0) { cfg.error = `--stale-days 只收非负数字："${v}"`; return cfg; }
        cfg.thresholds[id] = n * DAY;
      }
      continue;
    }
    cfg.error = `不认识的参数："${a}"`;
    return cfg;
  }
  return cfg;
}

/** 退出码：0 绿 / 2 有红项 / 1 出错。--strict 时 unknown 也算红。 */
export function exitCodeFor(summary = {}, strict = false) {
  const s = summary.counts || {};
  if ((s.stale || 0) + (s.never || 0) > 0) return 2;
  if (strict && (s.unknown || 0) > 0) return 2;
  return 0;
}

const GLYPH = Object.freeze({ fresh: "●", stale: "▲", never: "✖", unknown: "?" });

// 中文按 2 列宽算，不然表格会歪（这是给人看的表，歪了就没人看第二眼）
const width = (s) => Array.from(String(s)).reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
const pad = (s, w) => String(s) + " ".repeat(Math.max(0, w - width(s)));

export function renderTable(audit = {}) {
  const items = Array.isArray(audit.items) ? audit.items : [];
  // 阈值被 --stale-days 改过时，判据列要跟着说清楚"这一轮按几天判的"，
  // 不然表头写着 ≤7 天、实际按 0.5 天判红，看表的人只会觉得这表在瞎报。
  const overridden = (i) => (i.defaultDays && i.defaultDays !== i.thresholdDays ? `（本轮阈值 ${i.thresholdDays} 天）` : "");
  const rows = items.map((i) => ({
    机制: i.name,
    状态: `${GLYPH[i.state] || "?"} ${stateLabel(i.state)}`,
    最后产出: i.lastAtIso ? `${formatTime(i.lastAt)}（${humanAge(audit.now - i.lastAt)}前）` : "—",
    计数: String(i.count ?? 0),
    判据: `${i.criterion || ""}${overridden(i)}`,
  }));
  const cols = ["机制", "状态", "最后产出", "计数", "判据"];
  const widths = cols.map((c) => Math.max(width(c), ...rows.map((r) => width(r[c] ?? ""))));
  const line = (cells) => cells.map((c, k) => pad(c ?? "", widths[k])).join("  ").trimEnd();
  const out = [line(cols), widths.map((w) => "─".repeat(w)).join("  ")];
  for (const r of rows) out.push(line(cols.map((c) => r[c])));
  return out.join("\n");
}

/** 红项与无证据项的处置提示（表下一段，别让表后面空着） */
export function renderFindings(summary = {}) {
  const out = [];
  if (summary.issues?.length) {
    out.push("要处理：");
    for (const it of summary.issues) {
      out.push(`  ${GLYPH[it.state] || "?"} ${it.name}（${it.label}）— ${it.why}`);
      out.push(`      ↳ 查：${it.look}`);
    }
  }
  if (summary.unknown?.length) {
    out.push("无证据（不可判，别当绿）：");
    for (const it of summary.unknown) {
      out.push(`  ? ${it.name} — ${it.why}`);
      out.push(`      ↳ 查：${it.look}`);
    }
  }
  if (summary.flags?.length) {
    out.push("提词（状态不算红，但证据本身有话要说）：");
    for (const it of summary.flags) out.push(`  ! ${it.name} — ${it.note}`);
  }
  return out.join("\n");
}

const HELP = `元枢机制产出新鲜度体检

  node scripts/vitality.mjs [--root <工作区>] [--json] [--strict]
                            [--stale-days <天数>] [--stale-days <id>=<天数>]

默认工作区：按 yuanshu-space / pi-workspace 顺序认（Windows 先看 D:/E:/C:）

退出码  0 全绿 / 2 有停更或从未产出 / 1 参数或执行出错
判据    只看盘上的产出（mtime、行数、字段时间），不看进程、不看日志里的"成功"。`;

function main(argv) {
  const cfg = parseArgs(argv);
  if (cfg.error) {
    console.error(`参数错误：${cfg.error}`);
    console.error(HELP);
    return 1;
  }
  if (cfg.help) { console.log(HELP); return 0; }

  const wsRoot = cfg.root || existingWorkspace() || defaultWorkspace();
  let audit;
  try {
    audit = auditVitality({ wsRoot, thresholds: cfg.thresholds });
  } catch (e) {
    console.error(`体检失败：${(e && e.message) || e}`);
    return 1;
  }
  const summary = summarize(audit);

  if (cfg.json) {
    console.log(JSON.stringify({ wsRoot, now: audit.now, counts: audit.counts, summary, items: audit.items }, null, 2));
    return exitCodeFor(summary, cfg.strict);
  }

  console.log(`元枢机制产出新鲜度 · ${wsRoot}`);
  console.log(`体检时间 ${formatTime(audit.now)}\n`);
  console.log(renderTable(audit));
  console.log("");
  console.log(summary.line);
  const findings = renderFindings(summary);
  if (findings) { console.log(""); console.log(findings); }
  if (cfg.strict && (audit.counts.unknown || 0) > 0) {
    console.log("");
    console.log(`（--strict）${audit.counts.unknown} 项无证据按挂处理`);
  }
  return exitCodeFor(summary, cfg.strict);
}

// 只在直接跑时执行（被 import 做测试时不跑）
const invoked = (() => {
  try {
    const self = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
    return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === self;
  } catch { return false; }
})();

if (invoked) {
  process.exitCode = main(process.argv.slice(2));
}
