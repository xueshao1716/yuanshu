// ══════════════════════════════════════════════════════════
// engine/memory-gardener.mjs —— 记忆园丁（规则化安全版）
// MyAgents「记忆园丁 + 精确回执」思想的安全落地：定期扫描记忆，
// 检测【重复/流水账条目】【固定记忆过时的「当前状态」节堆积】【记忆日志膨胀】，
// 产出健康报告 + 人工处理建议。只报告、绝不自动改记忆——
// 记忆是重要资产，任何变更走人工/提案审批（零污染原则，正对用户「禁止流水账式重复条目」）。
// 用法：scanMemoryHealth(wsRoot) 纯函数（可单测）；gardenMemory(wsRoot) 供 time-engine 定时调用。
// ══════════════════════════════════════════════════════════
import { readFileSync, existsSync } from "node:fs";
import * as fs from "node:fs";
import { join, basename, dirname } from "node:path";
import { memoryPaths } from "./memory.mjs";
import { atomicWriteText } from "./atomic-io.mjs";
import { splitLogBlocks, blockTopic, isSupersededBlock } from "./memory-facts.mjs";

const DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = 7; // 「当前状态」节超过 7 天视作过时，建议归档
const LOG_BLOAT = 400; // 记忆日志超过该条数建议归档早期历史

// 记忆日志条目以 "### 日期 时间" 开头
// 记忆日志条目以 "### 日期" 或 "## 日期" 开头（两种风格并存，逐字保留原标题）
const HEADING_RE = /^#{2,4}\s\d{4}-\d{2}-\d{2}/;
function parseLog(raw) {
  const lines = raw.split("\n");
  const blocks = [];
  let cur = [];
  for (const ln of lines) {
    if (HEADING_RE.test(ln)) {
      if (cur.length) blocks.push(cur.join("\n"));
      cur = [ln];
    } else if (cur.length) {
      cur.push(ln);
    }
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks.filter(b => b.trim());
}

export function scanMemoryHealth(wsRoot) {
    const report = { totalEntries: 0, duplicates: [], contradictions: [], staleSections: { total: 0, staleCount: 0, staleDates: [] }, recommendations: [] };
  try {
    const paths = memoryPaths(wsRoot);

    // 1) 记忆日志：重复/流水账检测（要点行前 40 字去空白作 key，同 key 多次 = 疑似重复；带全文预览供人工核对）
    if (existsSync(paths.log)) {
      const raw = readFileSync(paths.log, "utf8");
      const blocks = parseLog(raw);
      report.totalEntries = blocks.length;
      const keyCount = {};
      for (const b of blocks) {
        const line = (b.split("\n").find(l => l.includes("要点：")) || b);
        const key = line.trim().replace(/\s+/g, "").slice(0, 40);
        if (!key) continue;
        (keyCount[key] = keyCount[key] || []).push(b);
      }
      for (const [key, arr] of Object.entries(keyCount)) {
        if (arr.length > 1) {
          report.duplicates.push({
            key, count: arr.length,
            dates: arr.map(b => (b.match(/###\s*([\d-]+)/)?.[1] || "")).filter(Boolean),
            previews: arr.map(b => b.replace(/\s+/g, " ").trim().slice(0, 120)),
          });
        }
      }
      const currentByTopic = {};
      for (const b of splitLogBlocks(raw).blocks) {
        const topic = blockTopic(b);
        if (!topic || isSupersededBlock(b)) continue;
        (currentByTopic[topic] = currentByTopic[topic] || []).push(b);
      }
      for (const [topic, arr] of Object.entries(currentByTopic)) {
        if (arr.length < 2) continue;
        report.contradictions.push({
          topic,
          count: arr.length,
          previews: arr.map(b => b.replace(/\s+/g, " ").trim().slice(0, 120)),
        });
      }
    }

    // 2) 固定记忆：过时的「当前状态」节堆积检测
    if (existsSync(paths.fixed)) {
      const raw = readFileSync(paths.fixed, "utf8");
      // 逐节解析「## 当前状态（日期）」节：带标题与正文预览，供人工核对具体内容
      const sections = [...raw.matchAll(/##\s*当前状态（([\d-]+)）([^\n]*)\n?([\s\S]*?)(?=\n## |$)/g)]
        .map(m => ({
          date: m[1],
          title: m[2].trim().slice(0, 40),
          preview: m[3].replace(/\s+/g, " ").trim().slice(0, 120),
        }));
      if (sections.length > 0) {
        const times = sections.map(s => new Date(s.date).getTime()).sort((a, b) => b - a);
        const newest = times[0];
        const staleList = sections.filter(s => (newest - new Date(s.date).getTime()) / DAY > STALE_DAYS);
        report.staleSections = {
          total: sections.length,
          staleCount: staleList.length,
          staleDates: staleList.map(s => s.date),
          sections: staleList.map(({ date, title, preview }) => ({ date, title, preview })),
          latestDate: sections.reduce((a, b) => (a.date > b.date ? a : b)).date,
        };
      }
    }

    // 3) 建议（只报告，不自动改）
    if (report.duplicates.length) report.recommendations.push(`发现 ${report.duplicates.length} 组疑似重复/流水账记忆条目（记忆日志），建议人工合并。`);
    if (report.contradictions.length) report.recommendations.push(`发现 ${report.contradictions.length} 组现行事实对撞（同一 topic 多条 current），请用 upsertMemoryFact 只留一条。`);
    if (report.staleSections.staleCount) report.recommendations.push(`固定记忆有 ${report.staleSections.staleCount} 个超过 ${STALE_DAYS} 天的过时「当前状态」节，建议归档到历史或精简。`);
    if (report.totalEntries > LOG_BLOAT) report.recommendations.push(`记忆日志已达 ${report.totalEntries} 条，建议归档最早历史条目。`);
  } catch (e) {
    report.error = String(e?.message || e);
  }
  return report;
}

// 园丁执行入口（供 time-engine 定时调用）：返回健康摘要，绝不动记忆内容
export function gardenMemory(wsRoot) {
  const r = scanMemoryHealth(wsRoot);
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, totalEntries: r.totalEntries, duplicates: r.duplicates.length, contradictions: r.contradictions.length, staleSections: r.staleSections.staleCount, recommendations: r.recommendations };
}

// 固定记忆/记忆日志的绝对路径暴露（供 API 挂载用）
export function gardenerPaths(wsRoot) { return memoryPaths(wsRoot); }

// ════════ 人工核对能力（08-26）：已核对标记 + 一键去重（带备份）════════
// 已核对记录存 记忆/园丁-已核对.json，只影响报告展示，不动记忆文件；
// 一键去重会改写记忆日志——先落 .bak 备份再重写，可手动恢复。

function reviewedPath(wsRoot) { return join(wsRoot, "记忆", "园丁-已核对.json"); }

export function getReviewed(wsRoot, fsMod = fs) {
  const p = reviewedPath(wsRoot);
  if (!fsMod.existsSync(p)) return [];
  try {
    const d = JSON.parse(fsMod.readFileSync(p, "utf8"));
    return Array.isArray(d?.items) ? d.items : [];
  } catch { return []; }
}

/** 标记某条发现为「已核对」（kind: dup|stale, key: 重复组 key 或 过时节日期） */
export function markReviewed(wsRoot, kind, key, fsMod = fs) {
  const items = getReviewed(wsRoot, fsMod).filter(x => !(x.kind === kind && x.key === key));
  items.push({ kind, key, ts: new Date().toISOString() });
  atomicWriteText(reviewedPath(wsRoot), JSON.stringify({ version: 1, items }, null, 2), fsMod);
  return items;
}

/** 撤销已核对标记 */
export function unmarkReviewed(wsRoot, kind, key, fsMod = fs) {
  const items = getReviewed(wsRoot, fsMod).filter(x => !(x.kind === kind && x.key === key));
  atomicWriteText(reviewedPath(wsRoot), JSON.stringify({ version: 1, items }, null, 2), fsMod);
  return items;
}

/**
 * 一键去重：每组重复保留日期最新的一条，其余删除。
 * 先把原日志完整备份为 记忆日志.md.bak-<时间戳>（可手动恢复），然后原子重写。
 * 返回 { removed, backup }。
 */
export function dedupeLog(wsRoot, fsMod = fs) {
  const paths = memoryPaths(wsRoot);
  if (!fsMod.existsSync(paths.log)) return { removed: 0, backup: null };
  const raw = fsMod.readFileSync(paths.log, "utf8");
  const blocks = parseLog(raw);
  const keyCount = {};
  for (const b of blocks) {
    const line = (b.split("\n").find(l => l.includes("要点：")) || b);
    const key = line.trim().replace(/\s+/g, "").slice(0, 40);
    if (!key) continue;
    (keyCount[key] = keyCount[key] || []).push(b);
  }
  const dropKeys = new Set(Object.entries(keyCount).filter(([, arr]) => arr.length > 1).map(([k]) => k));
  if (!dropKeys.size) return { removed: 0, backup: null };

  // 每个重复组内：按块内日期取最新的一条保留
  const keepIdx = new Set();
  for (const key of dropKeys) {
    const group = keyCount[key].map(b => ({ b, date: b.match(/###\s*([\d-]+)/)?.[1] || "" }));
    group.sort((x, y) => y.date.localeCompare(x.date));
    keepIdx.add(group[0].b);
  }
  let removed = 0;
  const kept = [];
  for (const b of blocks) {
    const line = (b.split("\n").find(l => l.includes("要点：")) || b);
    const key = line.trim().replace(/\s+/g, "").slice(0, 40);
    if (dropKeys.has(key)) {
      if (keepIdx.has(b)) { kept.push(b); continue; }
      removed++; continue;
    }
    kept.push(b);
  }

  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const backup = paths.log + ".bak-" + stamp;
  fsMod.writeFileSync(backup, raw, "utf8");
  atomicWriteText(paths.log, kept.join("\n\n") + "\n", fsMod);
  try { pruneLogBackups(wsRoot, LOG_BAK_KEEP, fsMod); } catch {}
  return { removed, backup };
}

// ══ .bak 保留上限 ══
// 备份是"后悔药"不是归档层：每次去重落一份【全量】日志（259KB），
// 2026-08-26 一天被调用 18 次就攒了 18 份 / 3.2MB。留最近几份足够回退，无上限只是第二种堆积。
export const LOG_BAK_KEEP = 5;
export function pruneLogBackups(wsRoot, keep = LOG_BAK_KEEP, fsMod = fs) {
  try {
    const paths = memoryPaths(wsRoot);
    const dir = dirname(paths.log);
    const prefix = basename(paths.log) + ".bak-";
    const names = fsMod.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().reverse();
    let removed = 0;
    for (const n of names.slice(Math.max(0, keep))) {
      try { fsMod.unlinkSync(join(dir, n)); removed++; } catch {}
    }
    return { ok: true, removed, kept: Math.min(names.length, keep) };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
}

// 报告附上已核对清单（供 UI 隐藏/折叠）
export function reviewedKeys(wsRoot, fsMod = fs) { return getReviewed(wsRoot, fsMod); }
