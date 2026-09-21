import { setTimeout as delay } from 'node:timers/promises';
import { reviewStoragePath } from './review-file-safety.mjs';
import { readReviewBounded } from './review-read.mjs';

export const isTeamRequest = body => body?.workflow === 'team-video' || /^\/team(?:\s|$)/i.test(String(body?.message || '').trim());
const contentText = content => typeof content === 'string' ? content : (content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
export function teamContext(messages = []) {
  return messages.filter(m => ['user', 'assistant'].includes(m.role)).slice(-2)
    .map(m => `${m.role}: ${contentText(m.content).slice(-6000)}`).join('\n').slice(-8000);
}

export function readTeamDraft(wsRoot, snapshot) {
  const id = snapshot?.runId;
  const expected = `工程/多AI角色扮演系统/runs/${id}/草稿/终稿.md`;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(id) || snapshot.delivery?.draft !== expected) throw new Error('天团草稿路径与本次运行不符');
  return readReviewBounded(reviewStoragePath(wsRoot, expected), 200_000).toString('utf8');
}

// Run-manager owns execution. The existing team runner owns only its bounded stages.
export function createTeamChat({ launcher, wsRoot, openSession, readMessages, aibodyHost, pollMs = 250 }) {
  return async (req, res, body) => {
    const rc = body.__runContext;
    if (!rc?.runId || !body.sessionId) throw new Error('天团任务需要通过会话任务入口启动');
    const task = String(body.message || '').replace(/^\/team\s*/i, '').trim();
    if (!task || task.length > 300 || /[\x00-\x1f]/.test(task)) throw new Error('天团任务须为 1–300 字单行文本');
    const entry = await openSession(body.sessionId);
    if (!entry || entry.busy) throw new Error(entry ? '会话正在执行其他任务' : '会话不存在');
    entry.busy = true; entry.busySince = Date.now();
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const turn = aibodyHost.attach({ res, runId: rc.runId, sessionId: body.sessionId, engine: 'yuanshu', source: 'chat', message: task, resume: rc.resume });
    let stopped = false, launchId;
    const onClose = () => { stopped = true; if (launchId) launcher.stop(launchId); };
    req.once('close', onClose);
    const appendOnce = async (role, text) => {
      if (entry.sm.fileEntries?.some(e => e.message?.teamRunId === rc.runId && e.message.role === role)) return;
      await entry.sm.appendMessage({ role, content: [{ type: 'text', text }], teamRunId: rc.runId, timestamp: Date.now() });
    };
    try {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const saved = rc.checkpoint?.team;
      const binding = saved?.binding || { runId: rc.runId, sessionId: body.sessionId,
        context: teamContext(readMessages(entry)), directive: String(turn.directive || '').slice(0, 4000) };
      await appendOnce('user', body.message);
      emit('engine_selected', { engine: 'yuanshu', workflow: 'team-video', reason: '天团角色协作' });
      if (req.destroyed) onClose();
      if (stopped) throw new Error('任务已停止');
      const events = (type, data) => emit(type, { ...data, parentRunId: rc.runId, sessionId: body.sessionId });
      let launch = launcher.status();
      // A restart can occur after spawn but before the run checkpoint was saved.
      const previousId = saved?.launchId || (launch?.runId === rc.runId ? launch.id : null);
      if (previousId) {
        if (launch?.id !== previousId || launch.runId !== rc.runId) throw new Error('原天团运行已变化，未自动重放');
        if (['running', 'launching', 'stopping'].includes(launch.status)) throw new Error('原天团进程仍在运行，请先停止或等待退出后恢复');
        if (launch.status !== 'completed') {
          const result = await launcher.resume(previousId, events);
          if (result.status !== 200) throw new Error(result.body.error);
          launch = result.body.launch;
        }
      } else {
        const result = await launcher.start(task, null, binding, events);
        if (result.status !== 200) throw new Error(result.body.error);
        launch = result.body.launch;
      }
      launchId = launch.id;
      rc.saveCheckpoint({ team: { launchId, binding }, phase: 'executing', step: 'team' });
      emit('team_started', { launchId, runId: rc.runId, sessionId: body.sessionId });
      if (stopped) launcher.stop(launchId);
      const deadline = Date.now() + 20 * 60_000;
      while (['launching', 'running', 'stopping'].includes(launch.status)) {
        if (Date.now() > deadline) { launcher.stop(launchId); throw new Error('天团任务超时，已请求停止；恢复前会检查不确定步骤'); }
        await delay(pollMs);
        launch = launcher.status();
        if (!launch || launch.id !== launchId) throw new Error('天团运行状态不可确认');
      }
      if (stopped || launch.status === 'stopped') { turn.finish({ status: 'cancelled' }); throw new Error('任务已停止'); }
      if (launch.status !== 'completed') throw new Error(launch.note || '天团执行中断');
      const snapshot = JSON.parse(readReviewBounded(reviewStoragePath(wsRoot, '工程/多AI角色扮演系统/team-run.json'), 16_000_000));
      if (snapshot.launchId !== launchId || snapshot.parentRunId !== rc.runId || snapshot.sessionId !== body.sessionId) throw new Error('天团结果不属于本次会话任务');
      const draft = snapshot.delivery?.draft;
      if (!draft) throw new Error('天团未提供可读取草稿');
      const text = readTeamDraft(wsRoot, snapshot);
      const summary = `天团执行已结束。质量检查 ${snapshot.checklist?.passed ?? 0}/${snapshot.checklist?.total ?? 0}；${snapshot.delivery.status === 'awaiting_acceptance' ? '草稿待人工验收' : '草稿未通过验收准备，请查看问题并继续修改'}。\n\n${text}`;
      await appendOnce('assistant', summary);
      emit('artifact_created', { path: draft, kind: 'draft', status: snapshot.delivery.status });
      emit('delta', { text: summary });
      emit('done', { sessionId: body.sessionId });
      res.end();
    } catch (error) {
      turn.finish({ status: stopped ? 'cancelled' : 'failed', summary: String(error.message) });
      throw error;
    } finally {
      req.off('close', onClose);
      // Rebuild the chat agent from committed history on the next ordinary turn.
      try { entry.agent?.dispose?.(); } catch {}
      entry.agent = null; entry.busy = false; entry.lastUsed = Date.now();
    }
  };
}
