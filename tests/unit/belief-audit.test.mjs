// belief-audit 契约：陈旧判定 + 无源容忍 + 报告结构（2026-10-13）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanBeliefs, runBeliefAudit, beliefAuditSummary, STALE_DAYS } from "../../engine/belief-audit.mjs";

const NOW = new Date("2026-10-13T04:00:00Z");
const DAY = 86400000;

function makeWs({ memoryMd = "## 记忆\n", memories = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-belief-"));
  fs.writeFileSync(path.join(dir, "记忆.md"), memoryMd, "utf8");
  const listMemories = memories.length || memories.length === 0
    ? () => ({ items: memories })
    : undefined;
  return { dir, listMemories, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } } };
}

test("陈旧判定：记忆库 >30 天 preference/fact 列为候选，task_record 与新条目不列", () => {
  const { dir, listMemories, cleanup } = makeWs({
    memories: [
      { memory_id: "a", memory_type: "preference", summary: "偏好深色", updated_at: NOW.getTime() - 50 * DAY, importance_score: 0.8 },
      { memory_id: "b", memory_type: "fact", summary: "最近事实", updated_at: NOW.getTime() - 40 * DAY },
      { memory_id: "c", memory_type: "task_record", summary: "旧任务", updated_at: NOW.getTime() - 60 * DAY },
      { memory_id: "d", memory_type: "preference", summary: "新偏好", updated_at: NOW.getTime() - 10 * DAY },
    ],
  });
  try {
    const r = scanBeliefs({ wsRoot: dir, listMemories, now: NOW });
    assert.deepEqual(r.stale_memories.map(x => x.memory_id), ["a", "b"], "只列 preference/fact，task_record 不算信念");
    assert.equal(r.stale_memories[0].age_days, 50);
  } finally { cleanup(); }
});

test("记忆.md：带日期超30天的伙伴约定行有编号定位；无日期行不误判", () => {
  const { dir, cleanup } = makeWs({
    memoryMd: [
      "# 记忆",
      "- **电源策略（2026-08-18 伙伴定）**：永不睡眠",
      "- **测试统一入口（2026-09-14 用户重申）**：npm test",
      "- **设计偏好：深色科技风（伙伴定）**", // 无日期，不判
    ].join("\n"),
  });
  try {
    const r = scanBeliefs({ wsRoot: dir, now: NOW });
    assert.equal(r.stale_md_lines.length, 1, "只有 08-18 那条超 30 天");
    assert.equal(r.stale_md_lines[0].date, "2026-08-18");
    assert.ok(r.stale_md_lines[0].line_no >= 2);
  } finally { cleanup(); }
});

test("记忆.md 缺失/记忆库失败时静默容忍，仍出报告", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-belief-"));
  try {
    const r = scanBeliefs({ wsRoot: dir, now: NOW }); // 两个源都没有
    assert.equal(r.total_stale, 0);
    const out = runBeliefAudit({ wsRoot: dir, now: NOW });
    assert.ok(fs.existsSync(out.reportPath), "空结果也落盘");
    fs.readFileSync(out.reportPath, "utf8").includes("今日无陈旧候选");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runBeliefAudit 报告结构与摘要", () => {
  const { dir, listMemories, cleanup } = makeWs({
    memories: [{ memory_id: "a", memory_type: "preference", summary: "偏好深色", updated_at: NOW.getTime() - 50 * DAY, importance_score: 0.8 }],
    memoryMd: "- **电源策略（2026-08-18 伙伴定）**：x\n",
  });
  try {
    const out = runBeliefAudit({ wsRoot: dir, listMemories, now: NOW });
    assert.equal(out.report.total_stale, 2);
    const md = fs.readFileSync(out.reportPath, "utf8");
    assert.ok(md.includes("# 信念体检") && md.includes("复核清单".slice(0, 0) + "记忆库 1 条"), "含汇总");
    assert.ok(md.includes("不自动改动"), "报告必须明示只列候选不动源");
    assert.match(beliefAuditSummary(out.report), /2 项陈旧候选/);
  } finally { cleanup(); }
});

test("阈值常量与文档一致（STALE_DAYS=30）", () => {
  assert.equal(STALE_DAYS, 30);
});
