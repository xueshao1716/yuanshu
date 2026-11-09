#!/usr/bin/env node
// ===== scripts/assembly.mjs —— 能力装配分级 CLI（2026-11-10）=====
//
// 用法：
//   node scripts/assembly.mjs              # 表格：能力 / 等级 / 缺口
//   node scripts/assembly.mjs --json       # 机器可读（每项带 evidence 与 gaps）
//   node scripts/assembly.mjs --root D:\pi-web
//   node scripts/assembly.mjs --help
//
// 退出码：
//   0  没有"写了没接"的项
//   2  有 implemented（有导出有测试、但没人调用）或 missing（清单里写了、盘上没有）
//   1  参数错误或执行出错
//
// 为什么 implemented 要单独判红：那是今晚最贵的假活——代码在、导出在、测试在，
// 就是没人调用。新鲜度看板对它完全无感（它只看盘上有没有新产出），所以这里单列。

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  gradeAll, summarize, renderTable, renderFindings, exitCodeFor,
} from "../engine/assembly.mjs";
import { CAPABILITIES } from "../engine/assembly-specs.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 纯函数：参数 → 配置。测试可以直接调，不用起子进程。 */
export function parseArgs(argv = []) {
  const cfg = { root: "", json: false, help: false, error: "" };
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--json") { cfg.json = true; continue; }
    if (a === "--help" || a === "-h") { cfg.help = true; continue; }
    if (a === "--root") {
      const v = args[i + 1];
      if (!v || v.startsWith("--")) { cfg.error = "--root 需要一个仓库路径"; return cfg; }
      cfg.root = v; i += 1; continue;
    }
    cfg.error = `不认识的参数："${a}"`;
    return cfg;
  }
  return cfg;
}

export { exitCodeFor };

const HELP = `元枢能力装配分级（defined → implemented → integrated → controllable）

  node scripts/assembly.mjs            表格：能力 / 等级 / 缺口
  node scripts/assembly.mjs --json     机器可读（含每项 evidence 与 gaps）
  node scripts/assembly.mjs --root <仓库>
  node scripts/assembly.mjs --help

四级判据（缺一级就停，gaps 写缺什么）：
  defined       声明的文件存在
  implemented   导出的符号 import() 拿得到，且测试文件存在
  integrated    非测试代码里真有调用点（排除注释/字符串/import 行，认 import 别名）
  controllable  有开关/闸/可查状态（环境变量 / 配置键 / API 路由 / 闸文件）

四格：✓ 已达成  ✗ 断在这一级  · 没走到

退出码  0 没有假活 / 2 有 implemented 或 missing / 1 参数或执行出错

这套判不了什么：只判文本里有调用（if(false) 里的也算）、只判一跳（B 挂了 C 看不出来）、
不看调用频率与效果、同名符号会互相顶替。别拿它当"接上了"的充分证明。`;

async function main(argv) {
  const cfg = parseArgs(argv);
  if (cfg.error) {
    console.error(`参数错误：${cfg.error}`);
    console.error(HELP);
    return 1;
  }
  if (cfg.help) { console.log(HELP); return 0; }

  const repoRoot = cfg.root ? path.resolve(cfg.root) : REPO_ROOT;
  let results;
  try {
    results = await gradeAll(CAPABILITIES, { repoRoot });
  } catch (e) {
    console.error(`装配分级失败：${(e && e.message) || e}`);
    return 1;
  }
  const summary = summarize(results);

  if (cfg.json) {
    console.log(JSON.stringify({
      repoRoot,
      summary: { total: summary.total, counts: summary.counts, line: summary.line },
      items: results,
    }, null, 2));
    return exitCodeFor(summary);
  }

  console.log(`元枢能力装配分级 · ${repoRoot}`);
  console.log(`清单 ${CAPABILITIES.length} 项（engine/assembly-specs.mjs）\n`);
  console.log(renderTable(results));
  console.log("");
  console.log(summary.line);
  const findings = renderFindings(summary);
  if (findings) { console.log(""); console.log(findings); }
  if (!summary.counts.implemented && !summary.counts.missing) {
    console.log("");
    console.log("没有假活：清单里的能力都在运行时接了调用点。");
  }
  return exitCodeFor(summary);
}

// 只在直接跑时执行（被 import 做测试时不跑）
const invoked = (() => {
  try {
    const self = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
    return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === self;
  } catch { return false; }
})();

if (invoked) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(`装配分级失败：${(e && e.message) || e}`);
    process.exitCode = 1;
  });
}
