import { spawnSubagent } from './subagent.mjs';

// The server-owned launcher supplies identity and events, never model arguments.
export function createTeamCompletion({ launcher }) {
  return async (body, signal) => {
    const host = launcher.childContext(body?.launchId);
    if (!host?.runId || !host.sessionId) throw Object.assign(new Error('缺少正在运行的天团会话绑定'), { statusCode: 409 });
    const { provider, modelId, message, role } = body;
    if (!provider || !modelId || typeof message !== 'string' || !message.trim() || message.length > 24000)
      throw Object.assign(new Error('模型与 1–24000 字正文任务必填'), { statusCode: 400 });
    const r = await spawnSubagent({ task: message, model: { provider, id: modelId },
      profile: 'team', outputFormat: 'text', timeoutMs: 180000, signal,
      role: /REVIEW|GUARD|ARBIT/.test(String(role)) ? 'reviewer' : 'planner',
      runId: host.runId, sessionId: host.sessionId,
      onEvent: (type, data) => host.onEvent?.(type, { ...data, agent: String(role || data.role).slice(0, 100) }),
    });
    if (!r.done) throw Object.assign(new Error(r.error || '子任务没有有效正文'), { statusCode: 502 });
    return { text: r.result, subagentRunId: r.subagentRunId, note: 'ok' };
  };
}
