// improve-api.mjs —— 自我改进提案（2026-08-21）
// 与曦 improvement_proposal.rs 对称：元枢工作数据 → 分析优缺点 → 主动提案改进。
// 数据源（本地零成本）：
//   - model-router 冷却计数（鉴权/额度错误 → 稳定性提案）
//   - stats-api 会话用量（token 烧钱 → 省钱提案）
//   - self-heal 自愈次数（自愈频繁 → 根因提案）
// 提案池：工程/经验库/improvements.jsonl（与 gene.mjs 的 proposals.json 分离，面向"行为改进"而非"基因基线"）
import fs from "node:fs";
import { atomicWriteText } from "./atomic-io.mjs";
import path from "node:path";
import { getCooldownHits } from "./model-router.mjs";

let wsRoot = "";
let getStats = null;   // () => { sessions: n, totalTokens: n, ... }
let getHealCount = null; // () => number

export function initImproveApi({ root = "", statsProvider = null, healProvider = null } = {}) {
  wsRoot = root;
  getStats = statsProvider;
  getHealCount = healProvider;
}

function file() { return path.join(wsRoot, "工程/经验库/improvements.jsonl"); }

function load() {
  const out = [];
  try {
    const content = fs.readFileSync(file(), "utf8");
    for (const line of content.split("\n").filter(Boolean)) {
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  } catch { /* 文件不存在 */ }
  return out;
}

function save(list) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  atomicWriteText(file(), list.map((p) => JSON.stringify(p)).join("\n") + "\n");
}

function makeProposal(kind, title, evidence, suggestion, priority) {
  return {
    id: "imp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    kind, title, evidence, suggestion, priority,
    status: "open",
    created_at: new Date().toISOString(),
  };
}

// The shared jsonl also stores evolution, skill-nudge and memory-nudge records.
// Keep those streams out of the ordinary improvement inbox; each has its own
// approval surface and uses `state`, while this module owns `status`.
function isImprovementProposal(p) {
  return p && (p.kind === "weakness" || p.kind === "efficiency" || p.kind === "improvement");
}

// 分析工作数据 → 生成改进提案（幂等：同标题不重复，只更新证据）
export function analyzeImprovements() {
  const existing = load();
  const props = [];
  const upsert = (p) => {
    const idx = existing.findIndex((e) => e.title === p.title && e.status === "open");
    if (idx >= 0) existing[idx] = { ...existing[idx], evidence: p.evidence };
    else props.push(p);
  };

  // 1. 稳定性：冷却频繁的 provider（鉴权/额度错误）
  try {
    const hits = typeof getCooldownHits === "function" ? getCooldownHits() : [];
    for (const h of hits) {
      if (h.count >= 3) {
        upsert(makeProposal(
          "weakness",
          `${h.provider} 频繁鉴权/额度错误（${h.count} 次冷却）`,
          `冷却 ${h.count} 次，原因: ${(h.reasons || []).join("; ") || "无"}`,
          `检查 ${h.provider} 的 key/额度，或降频调用；确认是否该换免费通道`,
          8,
        ));
      }
    }
  } catch { /* model-router 未初始化 */ }

  // 2. 省钱：token 用量大的会话
  try {
    const stats = typeof getStats === "function" ? getStats() : null;
    if (stats && stats.totalTokens > 5_000_000) {
      upsert(makeProposal(
        "efficiency",
        `累计 token 用量 ${(stats.totalTokens / 1e6).toFixed(1)}M`,
        `${stats.sessions || 0} 个会话，${(stats.totalTokens / 1e6).toFixed(1)}M tokens`,
        "收敛长会话/开新会话，优先小模型做简单任务",
        7,
      ));
    }
  } catch { /* 无统计 */ }

  // 3. 稳定性：自愈频繁
  try {
    const n = typeof getHealCount === "function" ? getHealCount() : 0;
    if (n >= 3) {
      upsert(makeProposal(
        "weakness",
        `自愈重启 ${n} 次（可能没解决根因）`,
        `health-monitor 自愈 ${n} 次`,
        "查根因（端口冲突/内存/依赖），而不是反复重启",
        9,
      ));
    }
  } catch { /* 无自愈计数 */ }

  if (props.length) save(existing.concat(props));
  return openImprovements();
}

export function openImprovements() {
  return load().filter((p) => isImprovementProposal(p) && p.status === "open")
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

export function getImprovementDiagnostics() {
  const rows = load();
  const open = rows.filter((p) => p?.status === "open" || p?.state === "open");
  return {
    total: rows.length,
    open: open.length,
    openImprovements: rows.filter((p) => isImprovementProposal(p) && p.status === "open").length,
    openEvolution: rows.filter((p) => p.kind === "evolution" && p.state === "open").length,
    openSkillNudge: rows.filter((p) => p.kind === "skill-nudge" && p.state === "open").length,
    openMemoryNudge: rows.filter((p) => p.kind === "memory-nudge" && p.state === "open").length,
  };
}

export function setImprovementStatus(id, status) {
  const list = load();
  const p = list.find((x) => x.id === id);
  if (!p) return { error: "提案不存在" };
  if (!isImprovementProposal(p)) return { error: "不是普通改进提案" };
  p.status = status;
  save(list);
  return { ok: true, status };
}
