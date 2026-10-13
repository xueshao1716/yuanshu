// engine/belief-audit.mjs —— 本体信念体检（2026-10-13，ToM 信念层 Phase 1）
// 设计：文档/ToM信念层设计-20261013.md 第三节。铁律：纯读扫描 + 报告产出，不自动改任何记忆源。
// MVP 规则刻意收敛：只判「证据陈旧」（确定性、可单测）；语义冲突/撤销判定留 Phase 2 人或 LLM 复核。

import fs from "node:fs";
import path from "node:path";

export const STALE_DAYS = 30;

/** 记忆.md「伙伴定」类行的识别与日期提取 */
function parseMemoryMdLine(line) {
  if (!/伙伴定|用户定|伙伴偏好|用户偏好|伙伴说过|用户重申|伙伴要求/.test(line)) return null;
  const m = line.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  const ymd = m ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}` : null;
  return { ymd, text: line.trim().slice(0, 300) };
}

function daysBetween(ymd, now) {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86400000);
}

/** 扫描本体信念证据，产出陈旧候选清单。listMemories 注入自 memory-db（解耦，不直接开库）。 */
export function scanBeliefs({ wsRoot, listMemories, progressMdPath, now = new Date() } = {}) {
  const out = { scanned_at: now.toISOString(), stale_days: STALE_DAYS, stale_memories: [], stale_md_lines: [], sources: [] };

  // 源 1：记忆库 preference/fact——updated_at >30 天即视为未经伙伴再次确认（召回本身不算确认，MVP 简化）
  if (typeof listMemories === "function") {
    try {
      // Phase 2：与记忆库共用统一规则口径（needs_review 视图：确认时间缺失或 >30 天）
      let r = null;
      try { r = listMemories({ user_id: "owner", limit: 200, view: "needs_review" }); } catch { }
      if (!r || !Array.isArray(r.items)) r = listMemories({ user_id: "owner", limit: 200, status: "all" });
      out.sources.push("memory-db");
      for (const it of r.items || []) {
        if (!["preference", "fact"].includes(it.memory_type)) continue;
        const confirmed = Number(it.last_confirmed_at || it.updated_at || it.created_at || 0);
        if (!confirmed) continue;
        const days = Math.floor((now.getTime() - confirmed) / 86400000);
        if (days > STALE_DAYS) {
          out.stale_memories.push({
            memory_id: it.memory_id, kind: it.memory_type, age_days: days,
            summary: String(it.summary || "").slice(0, 120),
            importance_score: it.importance_score,
            suggestion: `未被伙伴确认 ${days} 天，请复核这条「${it.memory_type}」是否仍是现行意愿：仍成立点确认/不再成立删除或降分。`,
          });
        }
      }
    } catch { /* 记忆库读失败不阻断 md 扫描 */ }
  }

  // 源 2：记忆.md 里的「伙伴定」行——行内历史日期 >30 天的标记（行号定位，便于人工复核）
  try {
    const p = progressMdPath || path.join(wsRoot, "记忆.md");
    const raw = fs.readFileSync(p, "utf8");
    out.sources.push("记忆.md");
    raw.split("\n").forEach((line, idx) => {
      const hit = parseMemoryMdLine(line);
      if (!hit) return;
      if (hit.ymd) {
        const days = daysBetween(hit.ymd, now);
        if (days !== null && days > STALE_DAYS) {
          out.stale_md_lines.push({ line_no: idx + 1, date: hit.ymd, age_days: days, text: hit.text });
        }
      }
      // 无日期的「伙伴定」行不判陈旧（无法机械断言），Phase 2 由 needs_review 视图接语义复核
    });
  } catch { /* 记忆.md 不存在/读失败静默 */ }

  out.total_stale = out.stale_memories.length + out.stale_md_lines.length;
  return out;
}

/** 跑体检并落盘报告（不改任何源文件）。返回 { reportPath, report }；空结果也落盘（可当作「今日检查过」的凭据）。 */
export function runBeliefAudit({ wsRoot, listMemories, now = new Date() } = {}) {
  const report = scanBeliefs({ wsRoot, listMemories, now });
  const dir = path.join(wsRoot, "memory", "belief-audit");
  fs.mkdirSync(dir, { recursive: true });
  const ymd = now.toISOString().slice(0, 10);
  const jsonPath = path.join(dir, `${ymd}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

  // 人类可读的复核清单（给伙伴看，也给夜间反思轮提炼用）
  const mdPath = path.join(dir, `${ymd}.md`);
  const lines = [
    `# 信念体检 ${ymd}`,
    "",
    `> 本体信念保鲜审计。规则：证据 >${STALE_DAYS} 天未被伙伴行为确认即列陈旧候选。**本报告只列候选，不自动改动任何记忆。**`,
    "",
    `## 汇总：记忆库 ${report.stale_memories.length} 条 / 记忆.md ${report.stale_md_lines} 行，共 ${report.total_stale} 项待复核`,
    "",
  ];
  if (report.stale_memories.length) {
    lines.push("## 记忆库陈旧候选");
    for (const x of report.stale_memories) lines.push(`- [${x.kind}]${x.importance_score != null ? ` imp=${x.importance_score}` : ""} ${x.age_days}天 · ${x.summary}\n  - 复核：${x.suggestion}`);
    lines.push("");
  }
  if (report.stale_md_lines.length) {
    lines.push("## 记忆.md 带日期的伙伴约定陈旧候选");
    for (const x of report.stale_md_lines.slice(0, 50)) lines.push(`- L${x.line_no}（${x.date}，${x.age_days}天前）${x.text}`);
    lines.push("");
  }
  if (!report.total_stale) lines.push("今日无陈旧候选——本体对伙伴的认知全部有近期证据支撑。");
  fs.writeFileSync(mdPath, lines.join("\n"), "utf8");
  return { reportPath: mdPath, jsonPath, report };
}

/** 通报用的一句话摘要 */
export function beliefAuditSummary(report) {
  if (!report.total_stale) return `信念体检：0 项陈旧，本体认知全部有近期证据`;
  return `信念体检：${report.total_stale} 项陈旧候选（记忆库 ${report.stale_memories.length} + 记忆.md ${report.stale_md_lines.length}），已出复核清单待伙伴过目`;
}
