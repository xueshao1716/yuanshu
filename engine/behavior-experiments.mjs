import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './file-lock.mjs';
import { reviewStoragePath, reviewAtomicWrite } from './review-file-safety.mjs';
import { readReviewBounded } from './review-read.mjs';
import { scopeKey } from './run-recovery.mjs';
import { experimentSource } from './behavior-experiment-source.mjs';
import { RECORD_LIMIT, EXPERIMENT_DIRECTORY, bounded, fields, text, recordInput,
  experimentHash, experimentError, comparisonState } from './behavior-experiment-contract.mjs';

// One immutable attempt set per id; revocation changes metadata, never erases evidence.
export function createBehaviorExperiments({ wsRoot, rootDir, allowSynthetic = false, now = () => new Date().toISOString() }) {
  const workspace = scopeKey(fs.realpathSync(wsRoot));
  const location = relative => reviewStoragePath(wsRoot, `${EXPERIMENT_DIRECTORY}/${relative}`);
  function fileFor(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw experimentError('无效的实验记录编号');
    return location(`${id}.json`);
  }
  function ids() {
    try {
      const names = fs.readdirSync(reviewStoragePath(wsRoot, EXPERIMENT_DIRECTORY));
      const result = names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => n.slice(0, -5));
      if (result.length > 200) throw experimentError('实验记录超过容量，请先人工归档', 409);
      return result;
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  function read(id) {
    try {
      const r = JSON.parse(readReviewBounded(fileFor(id), RECORD_LIMIT));
      const { recordHash, ...payload } = r;
      if (r.schema !== 1 || r.id !== id || r.workspace !== workspace || r.adoptionEligible !== false ||
        r.improvementProven !== false || !r.baseline || !Array.isArray(r.variants) || !Array.isArray(r.history) || !r.revision ||
        !['real-task', 'synthetic-fixture'].includes(r.sourceKind) || recordHash !== experimentHash(JSON.stringify(payload)))
        throw Error('invalid record');
      return r;
    } catch (e) { if (e.code === 'ENOENT') return null; throw experimentError('实验记录损坏或路径不安全，无法覆盖', 409); }
  }
  function write(id, value) {
    const { recordHash: previousHash, ...payload } = value;
    const sealed = { ...payload, recordHash: experimentHash(JSON.stringify(payload)) };
    // Corruption detection, not a signature against users with filesystem access.
    reviewAtomicWrite(fileFor(id), JSON.stringify(bounded(sealed)));
  }
  function get(id) {
    const r = read(id);
    if (!r) throw experimentError('实验记录不存在', 404);
    if (r.revokedAt) return { ...r, state: 'revoked' };
    try {
      for (const ref of [r.baseline, ...r.variants]) {
        const current = experimentSource({ wsRoot, rootDir, sessionId: r.sessionId }, { runId: ref.runId, version: ref.version });
        if (current.digest !== ref.digest) return { ...r, state: 'stale', reasons: ['来源、验收或产物指纹已变化，原始记录仅供追溯'] };
      }
    } catch { return { ...r, state: 'stale', reasons: ['来源不可核对，原始记录仅供追溯'] }; }
    return r;
  }
  async function record(body) {
    const input = recordInput(body, allowSynthetic);
    const id = experimentHash(JSON.stringify([workspace, input.sessionId, input.baseline.runId, input.experimentId, input.sourceKind]));
    const inputHash = experimentHash(JSON.stringify(input));
    return withFileLock(location('workspace-write.lock'), async () => {
      const old = read(id);
      if (old) {
        if (old.inputHash !== inputHash) throw experimentError('同一实验已记录不同内容，请使用新的实验编号', 409);
        return get(id);
      }
      if (ids().length >= 200) throw experimentError('实验记录已达 200 条上限，请先人工归档', 409);
      const capture = ref => experimentSource({ wsRoot, rootDir, sessionId: input.sessionId }, ref);
      const r = { schema: 1, id, workspace, ...input, inputHash, baseline: capture(input.baseline),
        variants: input.variants.map(capture), revision: randomUUID(), createdAt: now(), history: [],
        adoptionEligible: false, improvementProven: false };
      Object.assign(r, comparisonState(r));
      write(id, r);
      return get(id);
    });
  }
  async function revoke(id, body) {
    bounded(body); fields(body, ['revision', 'reason']);
    const reason = text(body.reason); fileFor(id);
    return withFileLock(location('workspace-write.lock'), async () => {
      const r = get(id);
      if (body.revision !== r.revision) throw experimentError('记录版本已变化，请刷新后撤回', 409);
      if (r.revokedAt) return r;
      const next = { ...r, revision: randomUUID(), revokedAt: now(), state: 'revoked',
        history: [...r.history, { revision: r.revision, state: r.state, at: now(), reason }] };
      write(id, next);
      return get(id);
    });
  }
  function list() {
    const items = [], counts = { 'real-task': 0, 'synthetic-fixture': 0, invalid: 0 };
    for (const id of ids()) {
      try {
        const r = read(id); counts[r.sourceKind]++;
        items.push({ id, experimentId: r.experimentId, sessionId: r.sessionId, sourceKind: r.sourceKind,
          createdAt: r.createdAt, revoked: !!r.revokedAt, freshness: 'check-detail', adoptionEligible: false });
      } catch { counts.invalid++; items.push({ id, state: 'invalid', adoptionEligible: false }); }
    }
    return { items, counts, limit: 200, adoptionEligible: false };
  }
  return { record, get, list, revoke };
}
