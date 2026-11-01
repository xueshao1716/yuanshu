// ===== engine/evolution/index.mjs —— 进化基础设施 v0（2026-11-02）=====
//
// 阶段 0 只做三件真事（不改行为、不自动改文件）：
//   ① 统一事件流：经验、对比、门禁、基因变更都写进一本 append-only 账
//   ② 提案 schema：带数据集/评估器版本、样本数、成本；状态机受控流转
//   ③ 能力画像 v0：从事件流滚出 成功率 / 一次过率 / 回退率（按任务类型）
//
// 设计纪律：
//   · 事件只追加，不原地改；改状态用新事件表达
//   · 提案不能自己从 PROPOSED 跳到 PROMOTED，必须逐步流转
//   · 画像只用真实事件算，没有样本就返回 null，不编数
import fs from "node:fs";
import path from "node:path";

export const EVOLUTION_REL = path.join("记忆", "运行时", "进化");
export const EVENTS_FILE = "events.jsonl";
export const PROPOSALS_FILE = "proposals.jsonl";

const dirOf = (wsRoot) => path.join(String(wsRoot || "."), EVOLUTION_REL);
const fileOf = (wsRoot, name) => path.join(dirOf(wsRoot), name);

const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const rid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const KIND = new Set(["task", "compare", "gate", "gene", "proposal", "observation"]);
const PASS = new Set(["pass", "keep", "green", "promoted", "stable"]);

export function appendEvent(wsRoot, input = {}) {
  const kind = String(input.kind || "");
  if (!KIND.has(kind)) return { ok: false, error: `未知 kind：${kind || "(空)"}` };
  const rec = {
    id: rid("evo_evt"),
    at: nowIso(input.at),
    kind,
    target: String(input.target || ""),          // skill | prompt | strategy | gene | agent
    targetId: String(input.targetId || ""),
    taskType: String(input.taskType || ""),      // coding | writing | research | ops
    verdict: String(input.verdict || ""),        // pass | keep | green | rollback | red | unknown
    n: Number.isFinite(Number(input.n)) ? Number(input.n) : null,
    cost: Number.isFinite(Number(input.cost)) ? Number(input.cost) : null,
    datasetVersion: String(input.datasetVersion || ""),
    evaluatorVersion: String(input.evaluatorVersion || ""),
    by: String(input.by || ""),                  // 谁触发的：commission / delivery / user / scheduler
    meta: input.meta && typeof input.meta === "object" ? input.meta : undefined,
  };
  try {
    fs.mkdirSync(dirOf(wsRoot), { recursive: true });
    fs.appendFileSync(fileOf(wsRoot, EVENTS_FILE), JSON.stringify(rec) + "\n", "utf8");
    return { ok: true, event: rec };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

export function readEvents(wsRoot, { kind = "", target = "", since = 0, limit = 500 } = {}) {
  let raw = "";
  try { raw = fs.readFileSync(fileOf(wsRoot, EVENTS_FILE), "utf8") } catch { return [] }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line) } catch { continue }
    if (kind && r.kind !== kind) continue;
    if (target && r.target !== target) continue;
    if (since && Date.parse(r.at) < since) continue;
    out.push(r);
  }
  return out.slice(-Math.max(1, limit));
}

/** 能力画像 v0：按 taskType 与 target 滚指标；样本不足返回 null 而不是编数。 */
export function summarizeCapability(events = [], { minN = 3 } = {}) {
  const byKey = new Map();
  const push = (key, ev) => {
    if (!byKey.has(key)) byKey.set(key, { key, attempts: 0, success: 0, rollback: 0, unknown: 0 });
    const row = byKey.get(key);
    row.attempts += 1;
    const v = String(ev.verdict || "");
    if (PASS.has(v)) row.success += 1;
    else if (v === "rollback" || v === "red" || v === "rejected") row.rollback += 1;
    else row.unknown += 1;
  };
  for (const ev of events) {
    if (!["task", "compare", "gate", "observation"].includes(ev.kind)) continue;
    const tt = ev.taskType || "未分类";
    push(`task:${tt}`, ev);
    if (ev.target && ev.targetId) push(`${ev.target}:${ev.targetId}`, ev);
  }
  const rows = [...byKey.values()].map((r) => {
    const scored = r.attempts - r.unknown;
    return {
      ...r,
      successRate: scored >= minN ? Number((r.success / scored).toFixed(3)) : null,
      rollbackRate: scored >= minN ? Number((r.rollback / scored).toFixed(3)) : null,
    };
  });
  rows.sort((a, b) => b.attempts - a.attempts);
  const total = events.filter((e) => ["task", "compare", "gate", "observation"].includes(e.kind)).length;
  return { total, minN, rows };
}

// ── 提案：schema + 状态机 ──
export const PROPOSAL_STATES = ["PROPOSED", "VALIDATING", "EXPERIMENTING", "EVALUATED", "AWAITING_APPROVAL", "PROMOTED", "MONITORING", "STABLE"];
export const FAIL_STATES = ["REJECTED", "ROLLED_BACK"];
const NEXT = {
  PROPOSED: ["VALIDATING", "REJECTED"],
  VALIDATING: ["EXPERIMENTING", "REJECTED"],
  EXPERIMENTING: ["EVALUATED", "REJECTED"],
  EVALUATED: ["AWAITING_APPROVAL", "REJECTED"],
  AWAITING_APPROVAL: ["PROMOTED", "REJECTED"],
  PROMOTED: ["MONITORING"],
  MONITORING: ["STABLE", "ROLLED_BACK"],
  STABLE: ["MONITORING"],
  REJECTED: [],
  ROLLED_BACK: [],
};

export function validateProposal(input = {}) {
  const errs = [];
  const need = ["agentId", "target", "targetId", "reason", "hypothesis", "parentVersion", "candidateVersion"];
  for (const k of need) if (!String(input[k] || "").trim()) errs.push(`缺字段：${k}`);
  for (const k of ["datasetVersion", "evaluatorVersion"]) if (!String(input[k] || "").trim()) errs.push(`缺字段：${k}（没有它就无法复现评估）`);
  if (!Number.isFinite(Number(input.n)) || Number(input.n) <= 0) errs.push("缺字段：n（样本数）");
  if (errs.length) return { ok: false, errors: errs };
  return {
    ok: true,
    proposal: {
      id: rid("evo"),
      at: nowIso(),
      agentId: String(input.agentId),
      target: String(input.target),
      targetId: String(input.targetId),
      reason: String(input.reason),
      hypothesis: String(input.hypothesis),
      parentVersion: String(input.parentVersion),
      candidateVersion: String(input.candidateVersion),
      datasetVersion: String(input.datasetVersion),
      evaluatorVersion: String(input.evaluatorVersion),
      n: Number(input.n),
      cost: Number.isFinite(Number(input.cost)) ? Number(input.cost) : null,
      risk: String(input.risk || "low"),
      status: "PROPOSED",
    },
  };
}

export function createProposal(wsRoot, input = {}) {
  const v = validateProposal(input);
  if (!v.ok) return v;
  try {
    fs.mkdirSync(dirOf(wsRoot), { recursive: true });
    fs.appendFileSync(fileOf(wsRoot, PROPOSALS_FILE), JSON.stringify(v.proposal) + "\n", "utf8");
  } catch (e) {
    return { ok: false, errors: [String(e?.message || e).slice(0, 160)] };
  }
  appendEvent(wsRoot, { kind: "proposal", target: v.proposal.target, targetId: v.proposal.targetId, verdict: "proposed", n: v.proposal.n, by: v.proposal.agentId, meta: { proposalId: v.proposal.id } });
  return v;
}

export function transitionProposal(wsRoot, proposal, next, { note = "" } = {}) {
  if (!proposal?.id) return { ok: false, reason: "没有提案" };
  const to = String(next || "");
  if (![...PROPOSAL_STATES, ...FAIL_STATES].includes(to)) return { ok: false, reason: `未知状态：${to}` };
  const allowed = NEXT[String(proposal.status)] || [];
  if (!allowed.includes(to)) return { ok: false, reason: `不允许 ${proposal.status} → ${to}` };
  const updated = { ...proposal, status: to, updatedAt: nowIso() };
  try {
    fs.mkdirSync(dirOf(wsRoot), { recursive: true });
    fs.appendFileSync(fileOf(wsRoot, PROPOSALS_FILE), JSON.stringify({ ...updated, note }) + "\n", "utf8");
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 160) };
  }
  appendEvent(wsRoot, { kind: "proposal", target: updated.target, targetId: updated.targetId, verdict: to.toLowerCase(), by: "system", meta: { proposalId: updated.id, from: proposal.status } });
  return { ok: true, proposal: updated };
}

/** 读提案：同一 id 取最后一条（append-only 的状态演进）。 */
export function readProposals(wsRoot) {
  let raw = "";
  try { raw = fs.readFileSync(fileOf(wsRoot, PROPOSALS_FILE), "utf8") } catch { return [] }
  const latest = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r?.id) latest.set(r.id, { ...(latest.get(r.id) || {}), ...r }) } catch {}
  }
  return [...latest.values()].sort((a, b) => String(b.updatedAt || b.at).localeCompare(String(a.updatedAt || a.at)));
}


/** 任务类型归类：从文字与改动文件推断（coding / writing / research / ops / design）。 */
export function classifyTaskType({ text = "", files = [] } = {}) {
  const t = String(text || "");
  const list = Array.isArray(files) ? files.join(" ") : String(files || "");
  const all = `${t} ${list}`;
  if (/\.(tsx?|jsx?|mjs|cjs|py|rs|go|java|vue|svelte|sh|ps1|sql)\b/i.test(list) || /代码|编程|重构|测试|bug|接口|函数/i.test(t)) return "coding";
  if (/\.(png|jpe?g|webp|svg|fig)$/i.test(list) || /海报|出图|封面|设计稿|配色/i.test(t)) return "design";
  if (/\.(md|docx?|txt)$/i.test(list) || /小说|文案|脚本|文章|写作|章节|排版/i.test(t)) return "writing";
  if (/调研|研究|查一下|检索|资料|竞品|对比分析/i.test(t)) return "research";
  if (/部署|重启|服务|备份|清理|迁移|线上/i.test(t)) return "ops";
  return "未分类";
}

/** 交付门判决入账：绿/黄/红都记，带任务类型与改动文件数。 */
export function recordGateVerdict(wsRoot, { verdict = "", changedFiles = [], blockers = [], runId = "", text = "" } = {}) {
  const taskType = classifyTaskType({ text, files: changedFiles });
  const v = String(verdict).toLowerCase();
  const mapped = v === "green" ? "green" : v === "yellow" ? "yellow" : v === "red" ? "red" : "unknown";
  return appendEvent(wsRoot, {
    kind: "gate",
    target: "delivery",
    targetId: runId || "run",
    taskType,
    verdict: mapped,
    n: Array.isArray(changedFiles) ? changedFiles.length : 0,
    by: "delivery-gate",
    meta: { changed: Array.isArray(changedFiles) ? changedFiles.slice(0, 8) : [], blockers: (blockers || []).slice(0, 4) },
  });
}
