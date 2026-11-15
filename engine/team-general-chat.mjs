import { executeTeam } from './team-subagents.mjs';
import { forkSeedFromHistory } from './subagent-fork.mjs';
import { reviewStoragePath, reviewAtomicWrite } from './review-file-safety.mjs';

// 工作台「天团」视图的 general 快照。general 走会话任务入口、没有 launcher，
// 不能覆盖视频流水线用来确认"本次进程真的产出了结果"的 team-run.json，所以单独落一条。
const GENERAL_SNAPSHOT = '工程/多AI角色扮演系统/team-run-general.json';

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
    // 快照只服务工作台展示；写失败不改变任务结论，run 事件与核验记录仍是权威。
    const writeSnapshot = state => {
      try {
        reviewAtomicWrite(reviewStoragePath(wsRoot, GENERAL_SNAPSHOT), JSON.stringify({
          workflow: 'team-general', runId: rc.runId, sessionId: body.sessionId, task: task.slice(0, 300),
          createdAt: new Date().toISOString(), mode: 'real', drivenBy: 'team-general', ...state,
        }));
      } catch {}
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
      const cancelled = signal.aborted || r.cancelled === true;
      writeSnapshot({ status: cancelled ? 'stopped' : r.isError ? 'failed' : 'completed',
        ...(r.isError ? { error: String(r.text).slice(0, 300) } : {}),
        ...(r.delivery ? { delivery: r.delivery } : {}) });
      if (r.isError) {
        const error = new Error(r.text);
        // 内容门禁失败：检查点里存的是同一批阶段结果，resume 重放只会得到同一条复核意见。
        // 标成不可续跑，让用户改任务重来。
        if (/^正文复核未通过/.test(String(r.text))) error.resumeUnavailable = true;
        throw error;
      }
      await append('assistant', r.text);
      emit('delta', { text: r.text });
      emit('done', { sessionId: body.sessionId });
      res.end();
    } catch (e) {
      const reason = String(e?.message || e);
      writeSnapshot({ status: signal.aborted ? 'stopped' : 'failed', error: reason.slice(0, 300),
        ...(e?.resumeUnavailable === true ? { resumeUnavailable: true } : {}) });
      // 失败也要在会话里留痕：否则 /api/sessions 查不到这一趟，用户会以为任务没发生。
      try {
        const hint = e?.resumeUnavailable === true ? '（本次不能续跑，请修改任务后重新发起）' : '';
        await append('assistant', `天团失败：${reason}${hint}`);
      } catch {}
      turn.finish({ status: signal.aborted ? 'cancelled' : 'failed', summary: reason });
      throw e;
    } finally {
      req.off('close', stop);
      try { entry.agent?.dispose?.(); } catch {}
      entry.agent = null; entry.busy = false; entry.lastUsed = Date.now();
    }
  };
}
