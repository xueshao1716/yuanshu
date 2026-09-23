import { reviewStoragePath } from './review-file-safety.mjs';
import { readReviewBounded } from './review-read.mjs';
import { evidenceHash, inspectArtifacts } from './task-evidence-artifacts.mjs';
import { resolveDeliveryReferences } from './task-evidence-deliveries.mjs';
import { evidenceSubagents } from './task-evidence-subagents.mjs';

export function evidenceError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
export function evidenceId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw evidenceError('无效的任务编号');
  return id;
}
export function readEvidenceRun(rootDir, id) {
  evidenceId(id);
  try {
    const run = JSON.parse(readReviewBounded(reviewStoragePath(rootDir, `runs/${id}.json`), 2 * 1024 * 1024));
    if (run.id !== id || !run.sessionId) throw new Error('invalid run');
    return run;
  } catch { throw evidenceError('运行记录缺失或无法读取', 404); }
}

export function taskEvidenceSnapshot({ wsRoot, rootDir, id }) {
  const run = readEvidenceRun(rootDir, id);
  const issues = [], references = [], calls = new Map(), skills = new Set(), finished = new Set();
  let events = [], text = '', raw = '';
  try {
    raw = readReviewBounded(reviewStoragePath(rootDir, `events/${id}.jsonl`), 4 * 1024 * 1024).toString('utf8');
    events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (!events.length || events.length > 10000 || events.some((e, i) => e.runId !== id || e.sessionId !== run.sessionId || e.seq !== i + 1))
      throw new Error('incomplete or foreign events');
  } catch { issues.push('运行事件不完整、过大或不属于这次任务'); events = []; }
  for (const e of events) {
    const d = e.data || {};
    if (e.type === 'delta' && typeof d.text === 'string') text += d.text;
    if (['tool', 'tool_start', 'tool_started'].includes(e.type) && d.id) {
      if (calls.has(d.id)) { issues.push('工具调用编号重复，无法确认技能来源'); continue; }
      calls.set(d.id, d);
    }
    if (['tool_end', 'tool_finished'].includes(e.type)) {
      if (finished.has(d.id)) issues.push('工具完成记录重复，无法确认技能来源');
      finished.add(d.id);
      const call = calls.get(d.id);
      if (call?.name === 'activate_skill' && d.name === 'activate_skill' && d.isError === false && !d.uncertain) {
        let args = call.args;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
        const skill = args?.name || args?.skill;
        if (typeof skill === 'string' && skill.length <= 150) skills.add(skill);
      }
    }
    if (['file', 'artifact_created'].includes(e.type) && d.path) references.push(d.path);
    if (['media', 'image'].includes(e.type)) {
      if (d.path || d.url) references.push(d.path || d.url);
      else issues.push('媒体交付没有可核对的本地文件');
    }
  }
  // Only explicit Markdown delivery links, never paths guessed from shell output.
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    if (m[0].startsWith('!') || m[1].startsWith('/api/ws/file?') || !/^https?:/i.test(m[1])) references.push(m[1]);
  }
  const resolved = resolveDeliveryReferences(wsRoot, references, events);
  const artifacts = inspectArtifacts(wsRoot, resolved);
  if (resolved.length > 20) issues.push('交付超过 20 个文件，需单独核验');
  if (artifacts.some(a => a.error)) issues.push('部分交付文件无法核对');
  if (!text.trim() && !artifacts.length) issues.push('没有可核对的回复或交付');
  if (text.length > 100000) issues.push('回复过长，需单独核验');
  if (run.status !== 'completed') issues.push('只有执行完成的任务可以标记合格');
  if (typeof run.request?.message !== 'string' || !run.request.message.trim()) issues.push('缺少完整原始任务说明，需单独核验');
  if (run.request?.files?.length || run.input?.attachments?.length) issues.push('输入附件缺少执行时的内容快照，暂需单独核验');
  const lane = run.request?.workflow === 'team-video' ? 'team' : 'task';
  if (lane === 'team') issues.push('天团交付请使用原有送审流程');
  const input = String(run.request?.message || run.input?.messagePreview || '');
  const subagents = evidenceSubagents(events, run, issues);
  const digest = evidenceHash(JSON.stringify({ id, status: run.status, request: run.request, input, raw, artifacts }));
  return { runId: id, sessionId: run.sessionId, input, status: run.status, at: run.createdAt, lane,
    digest, text: text.slice(0, 100000), skills: [...skills].sort(), subagents, artifacts, issues: [...new Set(issues)],
    reviewable: issues.length === 0 };
}
