#!/usr/bin/env node
// ===== scripts/memory-recall-compare.mjs —— 召回新旧对照（2026-11-15）=====
//
// 同一组查询，分别用「旧公式（字面相关 0.55/重要 0.30/时效 0.15）」和
// 「新混合分（kw .40 / vec .40 / imp .15 / fresh .05，阈值 0.45）」排序，
// 打印两者 top3 与差异——判断接向量后召回到底有没有变好，不靠感觉。
//
// 用法：
//   node scripts/memory-recall-compare.mjs                      # 内置 10 条样例查询
//   node scripts/memory-recall-compare.mjs --queries q.txt      # 文件（一行一个查询，# 开头跳过）
//   node scripts/memory-recall-compare.mjs --root D:\pi-workspace
//   node scripts/memory-recall-compare.mjs --top 5 --limit 8 --json
//
// 只读：不写库、不 touch 访问计数；每条查询只调一次 embedding（失败就中止并说明）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initEmbedding, embed, configInfo } from "../engine/embedding.mjs";
import { initMemoryDb, resetMemoryDb } from "../engine/memory/db.mjs";
import { compareRecall, initRecallEmbedding, loadRecallConfig } from "../engine/memory/recall.mjs";
import { defaultWorkspace } from "../engine/workspace-default.mjs";

// 内置样例：10 条，覆盖偏好/事实/任务记录三类，且尽量用"用户会怎么问"的自然语言
// （旧公式靠字面 bigram 命中，语义相近但换词的说法正是新向量该补上的）。
export const BUILTIN_QUERIES = Object.freeze([
  "哪些时候用了 503 的备用通道出图？",
  "小语的自画像现在是什么分辨率和路径？",
  "promises 白名单那次补了什么？",
  "delivery_check 的 GREEN 为什么不能全信？",
  "自改进的冒烟测试和双路径落盘",
  "定时任务和自检安排在哪天？",
  "散图归档到 E 盘还能恢复吗？",
  "agnes 通道的清晰度我嫌弃过吗？",
  "609 段对话视频交付的规格",
  "界面用深色科技风的产品展示页偏好",
]);

export function parseCompareArgs(argv = []) {
  const has = (f) => argv.includes(f);
  const val = (f) => {
    const i = argv.indexOf(f);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v && !String(v).startsWith("--") ? v : undefined;
  };
  const positiveInt = (raw, d) => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : d;
  };
  return {
    root: val("--root") || "",
    queriesFile: val("--queries") || val("--file") || "",
    top: positiveInt(val("--top"), 3),
    limit: positiveInt(val("--limit"), 8),
    json: has("--json"),
    help: has("--help") || has("-h"),
  };
}

export function loadQueries(file) {
  if (!file) return [...BUILTIN_QUERIES];
  const text = fs.readFileSync(file, "utf8");
  const qs = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
  if (!qs.length) throw new Error(`查询文件里没有有效行：${file}`);
  return qs;
}

const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toFixed(3));
const shorten = (s, n = 46) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

function printOne(result, index, total, top) {
  console.log("");
  console.log(`[${index + 1}/${total}] ${result.query}`);
  const e = result.embedding;
  console.log(`  查询向量  ${e.ok ? `ok（${e.model}，${e.ms}ms）` : `不可用：${e.error || "未配置"} → 新排序也退回旧公式`}`);
  const w = result.configUsed || {};
  console.log(`  覆盖率    ${result.vectors.coverageForRows ?? 0}/${result.vectors.total ?? "?"} 行有当前模型向量`);
  console.log("  旧 top" + top + "（字面 0.55 / 重要 0.30 / 时效 0.15）");
  for (const it of result.old.slice(0, top)) console.log(`    ${it.rank}. [${fmt(it.score)}] ${shorten(it.summary)}`);
  console.log("  新 top" + top + "（混合分）");
  for (const it of result.new.slice(0, top)) {
    const parts = it.scoreParts || {};
    const pp = `kw ${fmt(parts.kw)} + vec ${fmt(parts.vec)} + imp ${fmt(parts.imp)} + fresh ${fmt(parts.fresh)}`;
    console.log(`    ${it.rank}. [${fmt(it.score)}] ${shorten(it.summary)}  (${pp}${it.cos !== null ? `, cos ${fmt(it.cos)}` : ""})`);
  }
  const d = result.diff;
  const n = Math.min(top, result.old.length, result.new.length);
  const oldIds = new Set(result.old.slice(0, top).map(x => x.id));
  const newIds = new Set(result.new.slice(0, top).map(x => x.id));
  const overlap = [...newIds].filter(id => oldIds.has(id)).length;
  const dropped = result.old.slice(0, top).filter(x => !newIds.has(x.id));
  const bits = [];
  bits.push(d.top1Changed ? "top1 变了" : "top1 未变");
  bits.push(`top${top} 重叠 ${overlap}/${n}`);
  if (dropped.length) bits.push(`掉出：${dropped.map(x => shorten(x.summary, 24)).join("；")}`);
  console.log(`  差异      ${bits.join(" ｜ ")}`);
}

async function main() {
  const args = parseCompareArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法: node scripts/memory-recall-compare.mjs [--queries 文件] [--root 工作区] [--top 3] [--limit 8] [--json]");
    return 0;
  }
  const root = args.root || process.env.YUANSHU_WORKSPACE || process.env.PI_WORKSPACE || defaultWorkspace();
  initMemoryDb(root);
  initEmbedding(root);
  initRecallEmbedding(embed);
  try {
    const cfg = loadRecallConfig({ force: true });
    const queries = loadQueries(args.queriesFile);
    const info = configInfo();
    if (!info.configured) {
      console.error(`❌ embedding 未配置（工作区 ${root}/memory/embedding.json 或 ~/.pi/agent/auth.json 的 zai 凭据），无法做新旧对照。`);
      return 1;
    }
    const results = [];
    for (let i = 0; i < queries.length; i += 1) {
      const r = await compareRecall({ query: queries[i], limit: args.limit });
      r.configUsed = { enabled: cfg.enabled, weights: cfg.weights, vecThreshold: cfg.vecThreshold };
      results.push(r);
      if (!args.json) printOne(r, i, queries.length, args.top);
      if (!r.embedding.ok && r.embedding.error) {
        console.error(`\n❌ 第 ${i + 1} 条查询 embedding 失败，已中止：${r.embedding.error}`);
        return 1;
      }
    }
    if (args.json) { console.log(JSON.stringify({ root, config: cfg, results }, null, 2)); return 0; }

    const top = args.top;
    const changed = results.filter(r => r.diff.top1Changed).length;
    const overlaps = results.map(r => {
      const n = Math.min(top, r.old.length, r.new.length);
      const oldIds = new Set(r.old.slice(0, top).map(x => x.id));
      const newIds = new Set(r.new.slice(0, top).map(x => x.id));
      const hit = [...newIds].filter(id => oldIds.has(id)).length;
      return { hit, n };
    });
    const avgOverlap = overlaps.reduce((a, b) => a + b.hit / (b.n || 1), 0) / (overlaps.length || 1);
    const cosTop = results.map(r => r.new.find(it => it.cos !== null)?.cos ?? null).filter(v => v !== null);
    console.log("");
    console.log("═".repeat(64));
    console.log(`汇总：${results.length} 条查询 ｜ top1 改变 ${changed}/${results.length} ｜ top${top} 重叠均值 ${(avgOverlap * 100).toFixed(0)}%`);
    console.log(`配置：enabled=${cfg.enabled} ｜ kw ${cfg.weights.kw.toFixed(2)} / vec ${cfg.weights.vec.toFixed(2)} / imp ${cfg.weights.imp.toFixed(2)} / fresh ${cfg.weights.fresh.toFixed(2)} ｜ 阈值 ${cfg.vecThreshold}`);
    if (cosTop.length) console.log(`新排序 top 里的余弦范围：${Math.min(...cosTop).toFixed(3)} ~ ${Math.max(...cosTop).toFixed(3)}`);
    for (const r of results) {
      const o = r.old[0], n = r.new[0];
      console.log(`  ${r.diff.top1Changed ? "变" : "  "} 旧#1 ${shorten(o ? o.summary : "（无）", 30)}  →  新#1 ${shorten(n ? n.summary : "（无）", 30)}`);
    }
    console.log("═".repeat(64));
    return 0;
  } finally {
    resetMemoryDb();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`❌ 对照失败：${e?.stack || e}`);
    process.exitCode = 1;
  });
}
