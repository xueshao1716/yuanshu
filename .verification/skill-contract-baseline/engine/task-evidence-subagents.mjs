// Join only runtime-bound lifecycle facts. Role names are never skill labels.
export function evidenceSubagents(events, run, issues) {
  const children = new Map();
  for (const e of events) {
    if (!['subagent_started', 'subagent_finished'].includes(e.type)) continue;
    const d = e.data || {}, id = d.runId || d.id;
    if (!id || d.parentRunId !== run.id || d.sessionId !== run.sessionId || (d.id && d.id !== id)) {
      issues.push('部分子任务缺少一致的父任务与会话记录'); continue;
    }
    const previous = children.get(id);
    if (e.type === 'subagent_started') {
      if (previous) { issues.push('子任务启动记录重复，需核对'); continue; }
      const model = typeof d.model === 'string' ? d.model : [d.model?.provider, d.model?.id].filter(Boolean).join('/');
      children.set(id, { id, role: String(d.role || d.agent || '').slice(0, 100), model,
        status: 'running', summary: '', startedAt: d.startedAt || e.ts, endedAt: null });
    } else {
      if (!previous || previous.status !== 'running' || !['completed', 'failed', 'cancelled', 'interrupted'].includes(d.status)) {
        issues.push('子任务完成记录缺少对应启动或状态不一致'); continue;
      }
      Object.assign(previous, { status: d.status, endedAt: d.endedAt || e.ts,
        summary: String(d.error || d.summary || d.result || '').slice(0, 4000) });
    }
  }
  if ([...children.values()].some(r => r.status === 'running')) issues.push('部分子任务缺少结束记录');
  return [...children.values()];
}
