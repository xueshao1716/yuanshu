import { createHash } from 'node:crypto';
import { reviewPath, reviewStoragePath } from './review-file-safety.mjs';
import { readReviewBounded as readBounded } from './review-read.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

// Read-only observation, not authorization or an immutable proof of provenance.
// Keep this separate from the runner's historical submission snapshot.
export function resolveTeamAcceptance({ wsRoot, run }) {
  const delivery = run?.delivery;
  if (delivery?.status !== 'awaiting_acceptance') return null;
  const checkedAt = new Date().toISOString();
  const unknown = () => ({ status: 'unknown', checkedAt });
  try {
    const runId = run.runId;
    const id = delivery.proposalId;
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(runId) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(runId) ||
        typeof id !== 'string' || !/^p[a-z0-9-]{1,100}$/i.test(id)) return unknown();
    if (delivery.profile && delivery.profile !== 'general-team') return unknown();
    const general = delivery.profile === 'general-team';
    const base = general ? `工程/天团交付/${runId}` : `工程/多AI角色扮演系统/runs/${runId}`;
    if (delivery.target !== (general ? `${base}/验收稿.md` : `${base}/交付/终稿.md`) ||
        delivery.draft !== (general ? `${base}/草稿.md` : `${base}/草稿/终稿.md`)) return unknown();
    const target = reviewPath(wsRoot, delivery.target);
    const draft = reviewPath(wsRoot, delivery.draft);
    const proposal = reviewStoragePath(wsRoot, `工程/待审/${id}.json`);
    const result = status => ({ status, proposalId: id, checkedAt });
    let record;
    try { record = JSON.parse(readBounded(proposal, 16_000_000).toString('utf8')); }
    catch (e) { if (e.code === 'ENOENT') return result('record_missing'); throw e; }
    if (record?.id !== id || record.target !== delivery.target || typeof record.content !== 'string' ||
        Buffer.byteLength(record.content) > 2_000_000 ||
        !['pending', 'applying', 'needs_recovery', 'accepted', 'rejected'].includes(record.status)) return unknown();
    const approvedHash = hash(record.content);
    if (hash(readBounded(draft, 2_000_000)) !== approvedHash) return unknown();
    if (['accepted', 'rejected'].includes(record.status) &&
        (typeof record.decidedAt !== 'string' || !Number.isFinite(Date.parse(record.decidedAt)))) return unknown();
    if (record.status !== 'accepted') return result(record.status);
    try {
      return result(hash(readBounded(target, 2_000_000)) === approvedHash ? 'accepted' : 'target_changed');
    } catch (e) { if (e.code === 'ENOENT') return result('target_missing'); throw e; }
  } catch { return unknown(); }
}
