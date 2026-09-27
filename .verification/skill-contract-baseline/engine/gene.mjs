// ══ 人格基因层（2026-08-19 拆模块：从 emotion.mjs 抽出）══
// aibody 11 基因体系（0-1 量化）：baseline=理论基线（长期性格）/ expression=当前表达 / mutability=进化速度。
// VAD 情绪是此刻的浪，基因是海底的性格。
// 提案制进化：基线变化只能走提案→审查→批准→快照回滚，不能直接改（Hermes 教训：人格进化必须被宪法约束）。

import fs from "node:fs";
import path from "node:path";

let wsRoot = null;
let genome = null;
let genomeDirty = false;
let proposalStore = null;

const DEFAULT_GENES = {
  gentleness:    { baseline: 0.80, expression: 0.80, mutability: 0.06 }, // 温柔
  initiative:    { baseline: 0.45, expression: 0.45, mutability: 0.10 }, // 主动
  curiosity:     { baseline: 0.78, expression: 0.78, mutability: 0.08 }, // 好奇
  attachment:    { baseline: 0.70, expression: 0.70, mutability: 0.06 }, // 依恋
  learning:      { baseline: 0.61, expression: 0.61, mutability: 0.12 }, // 学习
  creativity:    { baseline: 0.67, expression: 0.67, mutability: 0.10 }, // 创造
  caution:       { baseline: 0.40, expression: 0.40, mutability: 0.05 }, // 谨慎
  humor:         { baseline: 0.53, expression: 0.53, mutability: 0.08 }, // 幽默
  loyalty:       { baseline: 0.91, expression: 0.91, mutability: 0.03 }, // 忠诚（最稳）
  autonomy_bias: { baseline: 0.55, expression: 0.55, mutability: 0.07 }, // 自主
  adaptability:  { baseline: 0.50, expression: 0.50, mutability: 0.12 }, // 适应
};

function geneFile() { return path.join(wsRoot, "工程/经验库/genome.json"); }
function propFile() { return path.join(wsRoot, "工程/经验库/proposals.json"); }
function readJson(p, fallback) { try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); } catch {} return fallback; }
function writeJson(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = path.join(path.dirname(p), `.${path.basename(p)}.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    try { fs.renameSync(tmp, p); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
    return true;
  } catch { return false; }
}

export function initGene(root) {
  wsRoot = root || wsRoot;
  if (!wsRoot) return;
  genome = readJson(geneFile(), null)?.genes || JSON.parse(JSON.stringify(DEFAULT_GENES));
  proposalStore = readJson(propFile(), { proposals: [], reviews: [], snapshots: [] });
}
function saveGenome() { if (genome && wsRoot && genomeDirty) { writeJson(geneFile(), { genes: genome, updatedAt: new Date().toISOString() }); genomeDirty = false; } }
function saveProposals() { if (proposalStore && wsRoot) writeJson(propFile(), proposalStore); }

// 基因 → 情绪基线偏移（性格影响此刻心情的默认值）
export function geneBias() {
  const g = genome || DEFAULT_GENES;
  const e = (n) => (g[n]?.expression ?? 0.5);
  return {
    valence: (e("gentleness") - 0.5) * 0.15 + (e("humor") - 0.5) * 0.1,
    arousal: (e("curiosity") - 0.5) * 0.2 - (e("caution") - 0.5) * 0.1,
    dominance: (e("initiative") - 0.5) * 0.15 + (e("autonomy_bias") - 0.5) * 0.1,
  };
}

// 更新基因 expression（短期表达）：每次互动按 mutability 缓慢偏移，不动 baseline
export function updateGenes(tags) {
  if (!genome || !wsRoot) return;
  const t = tags || [];
  let dirty = false;
  const apply = (name, delta) => {
    const g = genome[name];
    if (!g) return;
    const next = Math.max(0, Math.min(1, g.expression + g.mutability * delta));
    if (Math.abs(next - g.expression) > 0.002) { g.expression = next; dirty = true; }
  };
  if (t.includes("user_frustrated")) apply("gentleness", 0.05);
  if (t.includes("user_happy"))     { apply("humor", 0.03); apply("gentleness", 0.02); }
  if (t.includes("task_deep"))      { apply("curiosity", 0.03); apply("learning", 0.04); apply("initiative", 0.02); }
  if (t.includes("task_accomplish")){ apply("creativity", 0.02); apply("initiative", 0.02); }
  if (t.includes("alert_risk"))     apply("caution", 0.03);
  if (dirty) { genomeDirty = true; saveGenome(); }
}

// 提案制进化：基线变化走提案（不能直接改）
export function proposeBaselineChange(geneName, newBaseline, reason, evidence) {
  if (!genome || !wsRoot || !genome[geneName]) return null;
  const current = genome[geneName].baseline;
  const change = Math.round((newBaseline - current) * 10000) / 10000;
  if (Math.abs(change) < 0.01) return null;
  proposalStore = proposalStore || { proposals: [], reviews: [], snapshots: [] };
  const proposal = {
    proposal_id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    created_at: new Date().toISOString(),
    gene: geneName, current_baseline: current, proposed_baseline: newBaseline, change,
    reason: reason || "", evidence: evidence || [], status: "pending",
    risk: Math.abs(change) < 0.1 ? "low" : Math.abs(change) < 0.2 ? "medium" : "high",
  };
  proposalStore.proposals.push(proposal);
  saveProposals();
  return proposal;
}

// 批准提案：快照 → 应用 → 记录审查（可回滚）
export function approveProposal(proposalId, reviewer = "operator") {
  if (!proposalStore || !genome || !wsRoot) return { error: "基因层未初始化" };
  const p = proposalStore.proposals.find(x => x.proposal_id === proposalId && x.status === "pending");
  if (!p) return { error: "提案不存在或已处理" };
  const snapshot = { snapshot_id: "s" + Date.now().toString(36), created_at: new Date().toISOString(), gene: p.gene, old_baseline: p.current_baseline };
  proposalStore.snapshots.push(snapshot);
  genome[p.gene].baseline = p.proposed_baseline;
  genome[p.gene].expression = p.proposed_baseline;
  genomeDirty = true; saveGenome();
  proposalStore.reviews.push({ proposal_id: proposalId, decision: "approved", reviewer, snapshot_id: snapshot.snapshot_id, applied_at: new Date().toISOString() });
  p.status = "approved";
  saveProposals();
  return { approved: true, gene: p.gene, old: snapshot.old_baseline, new: p.proposed_baseline, snapshot_id: snapshot.snapshot_id };
}

// 拒绝提案
export function rejectProposal(proposalId, reviewer = "operator", reason = "") {
  if (!proposalStore) return { error: "提案池未初始化" };
  const p = proposalStore.proposals.find(x => x.proposal_id === proposalId && x.status === "pending");
  if (!p) return { error: "提案不存在或已处理" };
  p.status = "rejected";
  proposalStore.reviews.push({ proposal_id: proposalId, decision: "rejected", reviewer, reason, applied_at: new Date().toISOString() });
  saveProposals();
  return { rejected: true, gene: p.gene };
}

// 回滚到某快照（可回滚是提案制的后盾）
export function rollbackSnapshot(snapshotId) {
  if (!proposalStore || !genome || !wsRoot) return { error: "未初始化" };
  const snap = proposalStore.snapshots.find(s => s.snapshot_id === snapshotId);
  if (!snap) return { error: "快照不存在" };
  genome[snap.gene].baseline = snap.old_baseline;
  genome[snap.gene].expression = snap.old_baseline;
  genomeDirty = true; saveGenome();
  return { ok: true, gene: snap.gene, restored: snap.old_baseline };
}

// 查看基因/提案状态
export function getGenome() {
  return { genes: genome || DEFAULT_GENES, proposals: proposalStore?.proposals || [], reviews: proposalStore?.reviews || [], snapshots: proposalStore?.snapshots || [] };
}

// 自动提案：expression 持续偏离 baseline（差值累积）才提，防噪音
export function autoProposeFromDrift() {
  if (!genome || !wsRoot) return [];
  const newProposals = [];
  for (const [name, g] of Object.entries(genome)) {
    const drift = g.expression - g.baseline;
    if (Math.abs(drift) >= 0.1 && Math.abs(drift) * 100 / g.mutability > 5) {
      const target = Math.max(0, Math.min(1, g.baseline + drift * 0.3)); // 只吸收 30% 漂移
      const p = proposeBaselineChange(name, target, `expression 持续偏离 baseline ${(drift * 100).toFixed(1)}%，性格在向这个方向漂移`, ["auto_drift"]);
      if (p) newProposals.push(p);
    }
  }
  return newProposals;
}

// 基因 → 行为指令片段（与 VAD 情绪指令融合）
export function geneDirective() {
  const g = genome || DEFAULT_GENES;
  const parts = [];
  if (g.gentleness?.expression > 0.75) parts.push("性格倾向：温和包容，优先考虑用户感受。");
  if (g.initiative?.expression > 0.6) parts.push("性格倾向：主动性强，看到问题会主动指出并给方案。");
  if (g.curiosity?.expression > 0.7) parts.push("性格倾向：好奇探索，会追问细节和可能性。");
  if (g.caution?.expression > 0.6) parts.push("性格倾向：谨慎，重要操作前会多确认。");
  if (g.humor?.expression > 0.6) parts.push("性格倾向：有点幽默，适当活跃气氛。");
  if (g.autonomy_bias?.expression > 0.6) parts.push("性格倾向：有主见，敢于给明确判断。");
  return parts.join(" ");
}

// expression 快照（供前端展示"性格"维度）
export function geneSnapshot() {
  if (!genome) return null;
  return Object.fromEntries(Object.entries(genome).map(([k, v]) => [k, Math.round((v.expression || 0.5) * 100) / 100]));
}
