#!/usr/bin/env node
// ===== scripts/security-audit.mjs —— 元枢安全审计 CLI（2026-11-13）=====
//
// 用法：
//   node scripts/security-audit.mjs                 表格输出当前仓库/工作区
//   node scripts/security-audit.mjs --json          机器可读 JSON
//   node scripts/security-audit.mjs --repo D:\pi-web --ws D:\pi-workspace
// 退出码：0 无高危失败；2 有 high 失败（CI/发布前卡口）；1 审计本身跑挂了。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditSecurity } from "../engine/security-audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { json: false, repo: ROOT, ws: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--repo") out.repo = path.resolve(argv[++i] || ROOT);
    else if (a === "--ws" || a === "--workspace") out.ws = path.resolve(argv[++i] || "");
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-")) out.repo = path.resolve(a);
  }
  return out;
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    const wide = c === 0x2329 || c === 0x232a
      || (c >= 0x1100 && c <= 0x115f)
      || (c >= 0x2e80 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe6f)
      || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6)
      || (c >= 0x1f300 && c <= 0x1f64f)
      || (c >= 0x1f900 && c <= 0x1f9ff);
    width += wide ? 2 : 1;
  }
  return width;
}

function padEndWide(text, target) {
  const s = String(text);
  const pad = target - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

function truncateWide(text, target) {
  let out = "";
  let width = 0;
  for (const ch of String(text)) {
    const w = displayWidth(ch);
    if (width + w > target - 1) return `${out}…`;
    out += ch;
    width += w;
  }
  return out;
}

function renderTable(report, { repo, ws }) {
  const rows = report.checks;
  const high = rows.filter((r) => !r.ok && r.severity === "high").length;
  const medium = rows.filter((r) => !r.ok && r.severity === "medium").length;
  const low = rows.filter((r) => !r.ok && r.severity === "low").length;
  const lines = [];
  lines.push(`元枢安全审计 · ${repo}`);
  lines.push(`工作区: ${ws} · ${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  lines.push(`得分 ${report.score}/100 · ${report.ok ? "高危全部通过" : `高危未通过 ${high} 项`} · 中危 ${medium} · 低危 ${low}`);
  lines.push("");
  lines.push(`${padEndWide("ID", 12)}${padEndWide("级别", 8)}${padEndWide("结果", 6)}${padEndWide("检查项", 24)}判据`);
  lines.push(`${"─".repeat(12)}${"─".repeat(8)}${"─".repeat(6)}${"─".repeat(24)}${"─".repeat(40)}`);
  for (const r of rows) {
    const mark = r.ok ? "PASS" : "FAIL";
    lines.push(`${padEndWide(r.id, 12)}${padEndWide(r.severity, 8)}${padEndWide(mark, 6)}${padEndWide(truncateWide(r.title, 23), 24)}${truncateWide(r.detail, 110)}`);
    lines.push(`${" ".repeat(12)}└ 修复：${r.fix}`);
  }
  lines.push("");
  if (high > 0) lines.push(`结论：有 ${high} 项高危未通过（退出码 2）。先把高危修掉再暴露 8787。`);
  else lines.push("结论：没有高危失败；中/低危按修复建议排期。");
  return lines.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("用法: node scripts/security-audit.mjs [--json] [--repo <仓库根>] [--ws <工作区根>]");
    return 0;
  }
  let report;
  try {
    report = auditSecurity({
      wsRoot: opts.ws || undefined,
      config: { repoRoot: opts.repo },
    });
  } catch (e) {
    console.error(`[security-audit] 审计失败: ${String(e?.message || e).slice(0, 300)}`);
    return 1;
  }
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderTable(report, { repo: opts.repo, ws: opts.ws || opts.repo }));
  }
  return report.checks.some((r) => !r.ok && r.severity === "high") ? 2 : 0;
}

process.exitCode = main();
