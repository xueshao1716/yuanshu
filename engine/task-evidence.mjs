import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { reviewStoragePath, reviewAtomicWrite } from './review-file-safety.mjs';
import { readReviewBounded } from './review-read.mjs';
import { taskEvidenceSnapshot, readEvidenceRun, evidenceId, evidenceError } from './task-evidence-snapshot.mjs';
import { summarizeObjective } from './task-evidence-objective.mjs';

const DIRECTORY = '记忆/做梦/任务验收';
const MAX_REVIEWS = 200;
export function createTaskEvidence({ wsRoot, rootDir, now = () => new Date().toISOString() }) {
  const fileFor = id => reviewStoragePath(wsRoot, `${DIRECTORY}/${evidenceId(id)}.json`);
  const reviewIds = () => {
    try { return fs.readdirSync(reviewStoragePath(wsRoot, DIRECTORY)).filter(n => /^[a-zA-Z0-9_-]+\.json$/.test(n)).map(n => n.slice(0, -5)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  function readReview(id) {
    try {
      const r = JSON.parse(readReviewBounded(fileFor(id), 128 * 1024));
      if (r.runId !== id || !r.revision || !Array.isArray(r.skills) || !['pass', 'fail', 'revoke'].includes(r.verdict)) throw new Error('invalid review');
      return r;
    } catch (e) { if (e.code === 'ENOENT') return null; throw evidenceError('验收记录损坏，无法安全覆盖', 409); }
  }
  function get(id) {
    const snapshot = taskEvidenceSnapshot({ wsRoot, rootDir, id });
    const review = readReview(id);
    const acceptance = !review ? 'pending' : review.verdict === 'revoke' ? 'revoke' :
      review.digest !== snapshot.digest || (review.verdict === 'pass' && !snapshot.reviewable) ? 'stale' : review.verdict;
    const objective = summarizeObjective(snapshot.artifacts);
    return { ...snapshot, review, acceptance, objective,
      eligible: objective.status !== 'FAIL' && acceptance === 'pass' && review.skills.length > 0 && review.skills.every(s => snapshot.skills.includes(s)) };
  }
  function review(id, body = {}) {
    const current = get(id);
    const { verdict, digest, revision, skills, note } = body;
    if (current.lane === 'team') throw evidenceError('天团交付请使用原有送审流程');
    if (digest !== current.digest || revision !== (current.review?.revision || null)) throw evidenceError('记录已经变化，请刷新并重新核对', 409);
    if (!['pass', 'fail', 'revoke'].includes(verdict) || typeof note !== 'string' || !note.trim() || note.length > 2000 ||
        !Array.isArray(skills) || skills.length > 50 || skills.some(s => typeof s !== 'string' || !current.skills.includes(s)))
      throw evidenceError('请填写验收说明，只能确认本次实际成功使用的技能');
    if (verdict === 'pass' && !current.reviewable) throw evidenceError('本次交付暂不能标记合格，请查看原因');
    if (!current.review && reviewIds().length >= MAX_REVIEWS) throw evidenceError('验收记录已达 200 条上限，请先归档', 409);
    const previous = current.review;
    const history = previous ? [...(previous.history || []), { revision: previous.revision, verdict: previous.verdict,
      digest: previous.digest, at: previous.at, note: previous.note, skills: previous.skills }].slice(-20) : [];
    while (Buffer.byteLength(JSON.stringify(history)) > 80000) history.shift();
    const record = { schema: 1, runId: id, revision: randomUUID(), digest, verdict, note: note.trim(),
      skills: verdict === 'pass' ? [...new Set(skills)] : [], at: now(), source: 'human', history };
    reviewAtomicWrite(fileFor(id), JSON.stringify(record));
    return get(id);
  }
  function episodes() {
    const result = [];
    for (const id of reviewIds().slice(0, MAX_REVIEWS)) {
      try {
        if (readReview(id)?.verdict !== 'pass') continue;
        const row = get(id);
        if (!row.eligible) continue;
        result.push({ kind: 'skill-match', source: 'task-review', runId: id, sessionId: row.sessionId, input: row.input,
          at: row.at, choice: row.review.skills[0], choices: row.review.skills, objective: row.objective,
          verification: { source: 'human', verdict: 'PASS', skillValidated: true, reference: `task-review:${id}:${row.review.revision}` } });
      } catch { /* Unreadable evidence is never a positive label. */ }
    }
    return result;
  }
  function list() {
    const runs = fs.readdirSync(reviewStoragePath(rootDir, 'runs')).filter(n => /^[a-zA-Z0-9_-]+\.json$/.test(n))
      .map(n => { try { return readEvidenceRun(rootDir, n.slice(0, -5)); } catch { return null; } }).filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const reviewed = new Map();
    const summary = { pass: 0, fail: 0, revoke: 0, stale: 0, invalid: 0, eligible: 0,
      coverage: { text: 0, image: 0, document: 0, code: 0, media: 0, other: 0 } };
    for (const id of reviewIds().slice(0, MAX_REVIEWS)) {
      try {
        const row = get(id); reviewed.set(id, row);
        if (row.acceptance in summary) summary[row.acceptance]++;
        if (row.eligible) summary.eligible++;
        if (row.acceptance !== 'pass') continue;
        const kinds = row.artifacts.length ? new Set(row.artifacts.map(a => {
          const ext = a.path.split('.').pop().toLowerCase();
          if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
          if (['md', 'txt', 'pdf', 'docx', 'pptx', 'xlsx', 'csv'].includes(ext)) return 'document';
          if (['js', 'mjs', 'ts', 'tsx', 'py', 'html', 'css', 'json'].includes(ext)) return 'code';
          if (['mp4', 'webm', 'mp3', 'wav', 'ogg'].includes(ext)) return 'media';
          return 'other';
        })) : new Set(['text']);
        for (const kind of kinds) summary.coverage[kind]++;
      } catch { summary.invalid++; }
    }
    const recent = new Set(runs.slice(0, 40).map(run => run.id));
    const retained = new Set(reviewIds().slice(0, MAX_REVIEWS));
    const items = runs.filter(run => recent.has(run.id) || retained.has(run.id)).map(run => {
      try {
        const r = readReview(run.id);
        return { runId: run.id, input: String(run.request?.message || run.input?.messagePreview || '').slice(0, 160), at: run.createdAt,
          status: run.status, acceptance: r ? (reviewed.get(run.id) || get(run.id)).acceptance : 'pending', lane: run.request?.workflow === 'team-video' ? 'team' : 'task' };
      } catch { return { runId: run.id, input: '记录无法读取', at: run.createdAt, status: run.status, acceptance: 'invalid', lane: 'task' }; }
    });
    return { items, total: runs.length, limit: 40, retainedReviews: reviewIds().length, reviewLimit: MAX_REVIEWS, summary };
  }
  return { get, review, episodes, list, reviewedIds: reviewIds };
}
