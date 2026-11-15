import { spawnSubagent } from './subagent.mjs';
import { boardSummary, formatBoardContext } from './team-board.mjs';

// 收尾提示（2026-11-15）：天团成员干完活、走验收之前，看板上如果还挂着 pending / in_progress，
// 就在这里标出来。**只是提示，不阻断**：正文照常返回、状态照常 200，人工验收流程不受影响。
function boardLeftover(teamId, wsRoot) {
  const id = String(teamId || '');
  if (!id) return null;
  try {
    const summary = boardSummary(id, { wsRoot: wsRoot || undefined });
    if (summary.ok === false || summary.missing || !summary.total) return null;
    const by = summary.byStatus || {};
    const unfinished = (by.pending || 0) + (by.in_progress || 0);
    if (!unfinished) return null;
    return {
      teamId: id,
      total: summary.total,
      pending: by.pending || 0,
      inProgress: by.in_progress || 0,
      unfinished: [...(summary.inProgress || []), ...(summary.ready || [])].slice(0, 6),
      hint: formatBoardContext(summary),
    };
  } catch { return null; }
}

// The server-owned launcher supplies identity and events, never model arguments.
export function createTeamCompletion({ launcher, wsRoot = '' }) {
  return async (body, signal) => {
    const host = launcher.childContext(body?.launchId);
    if (!host?.runId || !host.sessionId) throw Object.assign(new Error('缺少正在运行的天团会话绑定'), { statusCode: 409 });
    const { provider, modelId, message, role } = body;
    if (!provider || !modelId || typeof message !== 'string' || !message.trim() || message.length > 24000)
      throw Object.assign(new Error('模型与 1–24000 字正文任务必填'), { statusCode: 400 });
    const r = await spawnSubagent({ task: message, model: { provider, id: modelId },
      profile: 'team', outputFormat: 'text', timeoutMs: 180000, signal,
      role: /REVIEW|GUARD|ARBIT/.test(String(role)) ? 'reviewer' : 'planner',
      // 天团成员身份：看板归属 + claim 的 owner。role 可能是「ARBIT裁决」这类阶段名，
      // 取首个大写词（ANALYST / VIDEO / ARBIT …）与预建任务 subject 前缀对齐。
      teamId: host.teamId || body?.launchId || '',
      member: (String(role || '').toUpperCase().match(/^[A-Z]+/) || [''])[0] || undefined,
      wsRoot,
      runId: host.runId, sessionId: host.sessionId,
      onEvent: (type, data) => host.onEvent?.(type, { ...data, agent: String(role || data.role).slice(0, 100) }),
    });
    if (!r.done) throw Object.assign(new Error(r.error || '子任务没有有效正文'), { statusCode: 502 });
    const board = boardLeftover(host.teamId || body?.launchId, wsRoot);
    return { text: r.result, subagentRunId: r.subagentRunId,
      note: board ? `ok（看板还有 ${board.pending + board.inProgress} 项未收尾）` : 'ok',
      ...(board ? { board } : {}) };
  };
}
