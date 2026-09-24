import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createPendingApi } from './pending-api.mjs';
import { reviewPath, reviewAtomicWrite } from './review-file-safety.mjs';
import { readReviewBounded } from './review-read.mjs';
import { resolveTeamAcceptance } from './team-acceptance.mjs';
import { deliveryDecision } from './team-delivery-contract.mjs';
import { inspectTimedSpeech } from './team-delivery-checks.mjs';
import { scopeKey } from './run-recovery.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const read = (root, file) => readReviewBounded(reviewPath(root, file), 2_000_000);
function paths(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) throw new Error('无效的天团交付编号');
  const base = `工程/天团交付/${id}`;
  return { draft: `${base}/草稿.md`, target: `${base}/验收稿.md`, evidencePath: `${base}/核验记录.json` };
}

// Host-observed text pipeline checks; not proof of media generation or human approval.
export async function stageGeneralTeamDelivery({ wsRoot, runId, sessionId, deliveryId, content, children, verdict }) {
  if (!runId || !sessionId || typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 2_000_000) throw new Error('天团交付内容或运行绑定无效');
  const locations = paths(deliveryId);
  const artifactDigest = hash(content);
  const evidenceFile = reviewPath(wsRoot, locations.evidencePath);
  if (fs.existsSync(evidenceFile)) {
    const existing = JSON.parse(read(wsRoot, locations.evidencePath));
    const validStatus = ['submission_started', 'submission_failed', 'awaiting_acceptance', 'quality_failed'].includes(existing.status);
    if (existing.profile !== 'general-team' || existing.deliveryId !== deliveryId || existing.parentRunId !== runId || existing.sessionId !== sessionId ||
        Object.entries(locations).some(([key, value]) => existing[key] !== value) || existing.artifactDigest !== artifactDigest ||
        !existing.evidence || existing.evidence.source !== 'runtime' || existing.evidence.scope !== 'text_pipeline_only' ||
        existing.evidence.artifactDigest !== artifactDigest || hash(JSON.stringify(existing.evidence)) !== existing.evidenceDigest ||
        !validStatus || (existing.status === 'quality_failed') !== (existing.evidence.passed === false) ||
        (existing.status === 'awaiting_acceptance' && (typeof existing.proposalId !== 'string' || !existing.proposalId)) ||
        hash(read(wsRoot, locations.draft)) !== artifactDigest) throw new Error('交付已经变化，未覆盖或重复提交');
    return existing.status === 'submission_started' ? { ...existing, status: 'submission_failed' } : existing;
  }
  const measured = inspectTimedSpeech(content);
  const observed = (children || []).map(child => ({ id: child.id, role: child.role, label: child.label, done: child.done === true }));
  const childrenComplete = observed.length >= 4 && observed.every(c => typeof c.id === 'string' && c.id && c.done) &&
    new Set(observed.map(c => c.id)).size === observed.length && ['IDEA', 'CHALLENGE', 'EXEC', 'REVIEW'].every(label => observed.some(c => c.label === label));
  const modelPassed = verdict?.pass === true && Array.isArray(verdict.issues) && verdict.issues.length === 0;
  const evidence = { source: 'runtime', scope: 'text_pipeline_only', artifactDigest,
    passed: childrenComplete && measured.issues.length === 0 && modelPassed, children: observed,
    checks: { childrenComplete, timedSpeech: measured }, modelReview: { pass: modelPassed, issues: verdict?.issues || [],
      ...(Array.isArray(verdict?.revisionChecks) ? { revisionChecks: verdict.revisionChecks } : {}) } };
  const delivery = { profile: 'general-team', deliveryId, parentRunId: runId, sessionId, ...locations, artifactDigest,
    evidence, evidenceDigest: hash(JSON.stringify(evidence)), status: evidence.passed ? 'submission_started' : 'quality_failed' };
  const draftFile = reviewPath(wsRoot, locations.draft);
  if (fs.existsSync(draftFile) && hash(read(wsRoot, locations.draft)) !== artifactDigest) throw new Error('已有草稿内容不同，未覆盖');
  reviewAtomicWrite(draftFile, content);
  // Persist intent before proposing. A crash in submission is uncertain, never auto-replayed.
  reviewAtomicWrite(evidenceFile, JSON.stringify(delivery, null, 2));
  if (evidence.passed) {
    const api = createPendingApi({ wsRoot, json: (_, status, body) => ({ status, ...body }) });
    const response = await api.create(null, { target: delivery.target, content, by: 'yuanshu-team',
      note: '天团文本草稿；子任务及有界程序检查已记录，模型复核不代表人工验收，也不代表图片或视频实测。' });
    delivery.status = response.ok ? 'awaiting_acceptance' : 'submission_failed';
    if (response.ok) delivery.proposalId = response.id;
    reviewAtomicWrite(evidenceFile, JSON.stringify(delivery, null, 2));
  }
  return delivery;
}

// Re-read mutable files on every observation. Events are historical, never approval.
export function readGeneralTeamDeliveries({ wsRoot, run, events = [] }) {
  if (!run?.backgroundRecovery?.scope || run.backgroundRecovery.scope !== scopeKey(wsRoot)) return [];
  const seen = new Set(), results = [];
  for (const event of events) {
    const d = event.type === 'artifact_created' ? event.data?.delivery : null;
    if (d?.profile !== 'general-team' || d.parentRunId !== run?.id || d.sessionId !== run?.sessionId || seen.has(d.deliveryId)) continue;
    seen.add(d.deliveryId);
    let fixed;
    try { fixed = paths(d.deliveryId); } catch { continue; }
    if (Object.entries(fixed).some(([key, value]) => d[key] !== value)) continue;
    const view = { deliveryId: d.deliveryId, ...fixed, proposalId: d.proposalId, artifactDigest: d.artifactDigest,
      scope: 'text_pipeline_only', decision: 'unverified', acceptance: { status: 'unknown' } };
    try {
      const current = JSON.parse(read(wsRoot, fixed.evidencePath));
      if (current.profile !== d.profile || current.deliveryId !== d.deliveryId || current.parentRunId !== run.id || current.sessionId !== run.sessionId ||
          Object.entries(fixed).some(([key, value]) => current[key] !== value) || current.artifactDigest !== d.artifactDigest ||
          current.proposalId !== d.proposalId || current.evidenceDigest !== d.evidenceDigest || hash(JSON.stringify(current.evidence)) !== d.evidenceDigest ||
          hash(read(wsRoot, fixed.draft)) !== d.artifactDigest) throw new Error('交付或核验记录已变化');
      const acceptance = resolveTeamAcceptance({ wsRoot, run: { runId: d.deliveryId, delivery: current } });
      view.acceptance = acceptance || { status: 'unknown' };
      view.decision = deliveryDecision({ execution: 'completed', artifactDigest: d.artifactDigest, evidence: current.evidence,
        acceptance: acceptance?.status === 'accepted' ? { ...acceptance, artifactDigest: d.artifactDigest } : acceptance });
      if (['target_changed', 'target_missing'].includes(acceptance?.status)) view.decision = 'acceptance_stale';
      else if (current.status === 'submission_failed' || current.status === 'submission_started') view.decision = 'submission_failed';
      else if (view.decision === 'awaiting_acceptance' && acceptance?.status !== 'pending') view.decision = 'unverified';
    } catch { /* Missing, altered or linked evidence must fail closed. */ }
    results.push(view);
  }
  return results;
}
