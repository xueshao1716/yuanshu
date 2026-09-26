// 子智能体执行台账：只保留有界、脱敏的生命周期摘要，不保存上下文或隐藏推理。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { redactSecrets } from "./tools/secrets-guard.mjs";

const MAX_TEXT = 4000;
const MAX_TASK = 1000;
const MAX_EVIDENCE = 6;
const MAX_EVIDENCE_TEXT = 500;
const MAX_HISTORY = 200;
const MEMORY_TRACES = new Map();

function bounded(value, max = MAX_TEXT) {
  return redactSecrets(String(value ?? ""))
    .replace(/\b(?:authorization|api[-_]?key|token|password|secret)\s*[:=]\s*\S+/gi, "[已脱敏]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").slice(0, max);
}

function safeId(value, fallback) {
  const id = bounded(value, 120).trim();
  return id || fallback;
}

function safeRole(value) {
  return ["analyst", "planner", "reviewer"].includes(value) ? value : "analyst";
}

function safeModel(model) {
  if (!model) return "";
  if (typeof model === "string") return bounded(model, 180);
  const provider = bounded(model.provider, 80);
  const id = bounded(model.id || model.model, 120);
  return provider && id ? `${provider}/${id}` : id || provider;
}

function safeEvidence(value) {
  return (Array.isArray(value) ? value : [])
    .map(item => bounded(item, MAX_EVIDENCE_TEXT).trim())
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE);
}

function normalizeRecord(input = {}) {
  const startedAt = input.startedAt || new Date().toISOString();
  return {
    runId: safeId(input.runId, `subagent-${Date.now()}`),
    role: safeRole(input.role),
    task: bounded(input.task, MAX_TASK),
    status: bounded(input.status || "running", 40),
    model: safeModel(input.model),
    result: bounded(input.result, MAX_TEXT),
    evidence: safeEvidence(input.evidence),
    confidence: typeof input.confidence === "number" && Number.isFinite(input.confidence)
      ? Math.max(0, Math.min(1, input.confidence)) : 0,
    error: bounded(input.error, 800),
    startedAt,
    endedAt: input.endedAt || "",
    parentRunId: bounded(input.parentRunId, 120),
    sessionId: bounded(input.sessionId, 120),
    attempt: Number.isFinite(Number(input.attempt)) ? Math.max(1, Number(input.attempt)) : 1,
    turn: Number.isFinite(Number(input.turn)) ? Math.max(1, Number(input.turn)) : 1,
    ordinal: Number.isFinite(Number(input.ordinal)) ? Math.max(1, Number(input.ordinal)) : 1,
    effectKey: bounded(input.effectKey, 180),
    ...(input.diagnostics ? { diagnostics: safeDiagnostics(input.diagnostics) } : {}),
  };
}

function safeDiagnostics(value) {
  const out = {};
  for (const key of ['outputBudget', 'inputTokensEstimate', 'inputTokens', 'outputTokens', 'reasoningTokens']) {
    out[key] = Number.isFinite(value[key]) && value[key] >= 0 ? Math.floor(value[key]) : null;
  }
  for (const key of ['errorCode', 'finishReason', 'usedModel']) out[key] = bounded(value[key], 180);
  return out;
}

function stableEffectKey({ role, task, parentRunId, sessionId }) {
  return crypto.createHash("sha256")
    .update([role || "analyst", task || "", parentRunId || "", sessionId || ""].join("\u0000"))
    .digest("hex").slice(0, 24);
}

async function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporary, file);
}

export class SubagentTraceStore {
  constructor(traceDir = "") {
    this.traceDir = traceDir ? path.resolve(String(traceDir)) : "";
    this.records = new Map();
    this.ready = this.recover();
  }

  async recover() {
    if (!this.traceDir) return;
    await fs.mkdir(this.traceDir, { recursive: true });
    let entries = [];
    try { entries = await fs.readdir(this.traceDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
      try {
        const file = path.join(this.traceDir, entry.name);
        const value = normalizeRecord(JSON.parse(await fs.readFile(file, "utf8")));
        if (value.status === "running") {
          value.status = "interrupted";
          value.error = "宿主在子任务结束前重启，已恢复为中断";
          value.endedAt = new Date().toISOString();
          await writeAtomic(file, value);
        }
        this.records.set(value.runId, value);
      } catch { /* Ignore unrelated or partially-written files. */ }
    }
  }

  async begin(input = {}) {
    await this.ready;
    const ordinal = this.records.size + 1;
    const record = normalizeRecord({ ...input, status: "running", ordinal, effectKey: input.effectKey || stableEffectKey(input) });
    this.records.set(record.runId, record);
    if (this.traceDir) await writeAtomic(path.join(this.traceDir, `${record.runId}.json`), record);
    return { ...record };
  }

  async finish(runId, patch = {}) {
    await this.ready;
    const current = this.records.get(runId) || normalizeRecord({ runId });
    const record = normalizeRecord({ ...current, ...patch, runId, endedAt: patch.endedAt || new Date().toISOString() });
    this.records.set(runId, record);
    if (this.traceDir) await writeAtomic(path.join(this.traceDir, `${record.runId}.json`), record);
    return { ...record };
  }

  async history({ sessionId, runId, limit = 50 } = {}) {
    await this.ready;
    const max = Math.min(MAX_HISTORY, Math.max(1, Number(limit) || 50));
    return [...this.records.values()]
      .filter(record => !sessionId || record.sessionId === bounded(sessionId, 120))
      .filter(record => !runId || record.parentRunId === bounded(runId, 120) || record.runId === bounded(runId, 120))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)) || b.ordinal - a.ordinal)
      .slice(0, max)
      .map(record => ({ ...record, evidence: [...record.evidence] }));
  }
}

export function configureSubagentTraces(traceDir = "") {
  const store = new SubagentTraceStore(traceDir);
  if (!traceDir) MEMORY_TRACES.clear();
  return store;
}

export function rememberInMemoryTrace(record) {
  if (!record?.runId) return;
  MEMORY_TRACES.set(record.runId, normalizeRecord(record));
  while (MEMORY_TRACES.size > MAX_HISTORY) MEMORY_TRACES.delete(MEMORY_TRACES.keys().next().value);
}

export function historyFromMemory({ sessionId, runId, limit = 50 } = {}) {
  const sid = sessionId ? bounded(sessionId, 120) : "";
  const pid = runId ? bounded(runId, 120) : "";
  return [...MEMORY_TRACES.values()]
    .filter(record => !sid || record.sessionId === sid)
    .filter(record => !pid || record.parentRunId === pid || record.runId === pid)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)) || b.ordinal - a.ordinal)
    .slice(0, Math.min(MAX_HISTORY, Math.max(1, Number(limit) || 50)))
    .map(record => ({ ...record, evidence: [...record.evidence] }));
}

/** Read-only history export for stats/observability consumers. */
export async function getSubagentHistory({ sessionId, runId, limit = 50, traceDir } = {}) {
  if (traceDir) return new SubagentTraceStore(traceDir).history({ sessionId, runId, limit });
  return historyFromMemory({ sessionId, runId, limit });
}

export { bounded, safeEvidence, safeModel, safeRole, stableEffectKey };
