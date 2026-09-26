import { readEvidenceRun } from './task-evidence-snapshot.mjs';
import { createTaskEvidence } from './task-evidence.mjs';
import { reviewStoragePath } from './review-file-safety.mjs';
import { readReviewBounded } from './review-read.mjs';
import { deriveRunObservability } from './run-observability.mjs';
import { inWorkspace } from './learning-intake.mjs';
import { sanitizeText } from './sanitize.mjs';
import { bounded, experimentError, experimentHash } from './behavior-experiment-contract.mjs';

// Read existing facts only: never execute a tool, generate content, or accept caller scores.
export function experimentSource({ wsRoot, rootDir, sessionId }, ref) {
  const run = readEvidenceRun(rootDir, ref.runId);
  if (!inWorkspace(run, wsRoot) || run.sessionId !== sessionId) throw experimentError('任务不属于当前工作空间或会话', 403);
  let raw = '', events = [], eventIssue = null;
  try {
    raw = readReviewBounded(reviewStoragePath(rootDir, `events/${run.id}.jsonl`), 4 * 1024 * 1024).toString('utf8');
    events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (!events.length || events.length > 10000 || events.some((e, i) => e.runId !== run.id || e.sessionId !== sessionId || e.seq !== i + 1)) throw Error('invalid events');
  } catch { events = []; eventIssue = '运行事件缺失、过大或来源不符'; }
  const snapshot = createTaskEvidence({ wsRoot, rootDir }).get(run.id);
  const observations = [];
  for (const event of events) {
    const usage = event.data?.usage || (event.type === 'usage' ? event.data : null);
    if (!usage || typeof usage !== 'object') continue;
    const known = {};
    for (const key of ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'inputTokens', 'outputTokens', 'totalTokens', 'cost'])
      if (typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0) known[key] = usage[key];
    if (Object.keys(known).length) observations.push({ seq: event.seq, ...known });
  }
  const observed = deriveRunObservability(run, events);
  const validation = { acceptance: snapshot.acceptance, reviewable: snapshot.reviewable,
    revision: snapshot.review?.revision || null, source: snapshot.review?.source || null,
    objective: snapshot.objective.status, scope: 'existing-task-review-not-relative-improvement' };
  const failureEvent = events.find(e => ['failed', 'error', 'interrupted', 'stopped'].includes(e.type) ||
    e.data?.truncated === true || ['length', 'max_tokens'].includes(e.data?.finish_reason || e.data?.finishReason));
  const failure = run.error || (failureEvent ? failureEvent.data?.message || failureEvent.data?.error ||
    failureEvent.data?.finish_reason || failureEvent.data?.finishReason || failureEvent.type : null);
  const result = bounded({ ...ref, sessionId, status: run.status,
    digest: experimentHash(JSON.stringify({ run, raw, snapshotDigest: snapshot.digest, review: snapshot.review })),
    inputDigest: experimentHash(JSON.stringify({ message: run.request?.message, files: run.request?.files || [] })),
    artifacts: snapshot.artifacts,
    facts: { textModel: observed.textModel, mediaModels: observed.mediaModels, engine: observed.engine },
    usage: { source: 'run-events', complete: false, cost: null, observations },
    validation, failure: failure ? sanitizeText(String(failure)).slice(0, 2000) : null,
    issues: [...snapshot.issues, ...(eventIssue ? [eventIssue] : [])] });
  // Detect a writer changing source records during capture; no mixed-version evidence.
  if (experimentHash(JSON.stringify(readEvidenceRun(rootDir, ref.runId))) !== experimentHash(JSON.stringify(run)))
    throw experimentError('运行记录在读取中发生变化，请稍后重试', 409);
  return result;
}
