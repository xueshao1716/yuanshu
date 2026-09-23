import { executeTeam } from './team-subagents.mjs';
import { forkSeedFromHistory } from './subagent-fork.mjs';

export function createGeneralTeamChat({ wsRoot, openSession, readMessages, aibodyHost, getModel }) {
  return async (req, res, body) => {
    const rc = body.__runContext;
    if (!rc?.runId || !body.sessionId) throw new Error('天团需要会话任务入口');
    const entry = await openSession(body.sessionId);
    if (!entry || entry.busy) throw new Error(entry ? '会话正在执行其他任务' : '会话不存在');
    const task = String(body.message || '').replace(/^\/team\s*/i, '').trim();
    entry.busy = true; entry.busySince = Date.now();
    const ac = new AbortController();
    const stop = () => ac.abort();
    req.once('close', stop);
    if (req.destroyed) stop();
    const signal = rc.signal ? AbortSignal.any([ac.signal, rc.signal]) : ac.signal;
    const turn = aibodyHost.attach({ res, runId: rc.runId, sessionId: body.sessionId, engine: 'yuanshu', source: 'chat', message: task, resume: rc.resume });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const append = async (role, text) => {
      if (entry.sm.fileEntries?.some(e => e.message?.teamRunId === rc.runId && e.message.role === role)) return;
      await entry.sm.appendMessage({ role, content: [{ type: 'text', text }], teamRunId: rc.runId, timestamp: Date.now() });
    };
    try {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const saved = rc.checkpoint?.team?.general;
      const history = saved?.history || forkSeedFromHistory(readMessages(entry)).messages;
      const model = saved?.model || getModel?.(entry);
      await append('user', body.message);
      emit('engine_selected', { engine: 'yuanshu', workflow: 'team-general', reason: '天团共用子任务执行器' });
      if (model) emit('model_selected', { model: `${model.provider}/${model.id}`, provider: model.provider, modelId: model.id });
      const r = await executeTeam({ task }, { wsRoot, runId: rc.runId, sessionId: body.sessionId, signal, onEvent: emit,
        model, history, aibodyContext: { goal: task, strategy: turn.directive }, teamState: saved,
        saveTeamState: state => rc.saveCheckpoint?.({ team: { general: { ...state, history, model } }, phase: 'executing', step: 'team-general' }),
      });
      if (r.isError) throw new Error(r.text);
      await append('assistant', r.text);
      emit('delta', { text: r.text });
      emit('done', { sessionId: body.sessionId });
      res.end();
    } catch (e) { turn.finish({ status: signal.aborted ? 'cancelled' : 'failed', summary: String(e.message) }); throw e; }
    finally {
      req.off('close', stop);
      try { entry.agent?.dispose?.(); } catch {}
      entry.agent = null; entry.busy = false; entry.lastUsed = Date.now();
    }
  };
}
