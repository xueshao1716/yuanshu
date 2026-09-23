import fs from 'node:fs';
import { reviewStoragePath, reviewAtomicWrite } from './review-file-safety.mjs';
import { readReviewBounded } from './review-read.mjs';
import { resolveTeamAcceptance } from './team-acceptance.mjs';

const base = '工程/多AI角色扮演系统/runs';
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(id);
export function ingestLatestTeamEvidence(wsRoot) {
  try {
    const file = reviewStoragePath(wsRoot, '工程/多AI角色扮演系统/team-run.json');
    return recordTeamEvidence(wsRoot, JSON.parse(readReviewBounded(file, 4000000).toString('utf8')));
  } catch { return { ok: false, reason: '没有可读取的真实天团记录' }; }
}
export function recordTeamEvidence(wsRoot, run) {
  if (run?.mode !== 'real' || !validId(run.runId)) return { ok: false, reason: '缺少真实运行标识' };
  try {
    const file = reviewStoragePath(wsRoot, `${base}/${run.runId}/evolution-evidence.json`);
    // Immutable per-run facts; acceptance is resolved separately from review records.
    if (fs.existsSync(file)) return { ok: true, existing: true };
    const snapshot = { runId: run.runId, mode: run.mode, task: run.task, createdAt: run.createdAt,
      parentRunId: run.parentRunId || null, sessionId: run.sessionId || null,
      profile: run.profile, model: run.model, delivery: run.delivery, checklist: run.checklist,
      stages: run.stages, unresolved: run.unresolved, elapsedMs: run.elapsedMs, cost: run.cost };
    reviewAtomicWrite(file, JSON.stringify(snapshot));
    return { ok: true };
  } catch (e) { return { ok: false, reason: String(e.message) }; }
}

// Bounded read-only collector: never changes approval records or trains on a
// model's self-rating. A team result does not label a skill or a fix retry policy.
export function collectTeamEvidence(wsRoot) {
  let dirs;
  try { dirs = fs.readdirSync(reviewStoragePath(wsRoot, base), { withFileTypes: true }); } catch { return []; }
  const records = [];
  for (const dir of dirs.filter(d => d.isDirectory() && validId(d.name)).slice(-300)) {
    try {
      const file = reviewStoragePath(wsRoot, `${base}/${dir.name}/evolution-evidence.json`);
      const run = JSON.parse(readReviewBounded(file, 1000000).toString('utf8'));
      if (run.runId !== dir.name || run.mode !== 'real') continue;
      const acceptance = resolveTeamAcceptance({ wsRoot, run }) || { status: run.delivery?.status || 'unknown' };
      const c = run.checklist;
      const reviewed = Number.isSafeInteger(c?.total) && c.total > 0 && c.passed === c.total && c.failed === 0;
      records.push({ runId: run.runId, domain: 'team', at: run.createdAt, task: run.task,
        profile: run.profile, textModel: run.model || null,
        modelReview: { verdict: reviewed ? 'PASS' : 'UNVERIFIED', checklist: c || null },
        acceptance, accepted: acceptance.status === 'accepted', eligibleForFixPolicy: false,
        cost: { elapsedMs: Number.isFinite(run.elapsedMs) ? run.elapsedMs : null,
          reservedCalls: run.cost?.reservedCalls ?? null, currency: null, tokens: null },
      });
    } catch { /* Invalid evidence is never accepted. */ }
  }
  return records.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
