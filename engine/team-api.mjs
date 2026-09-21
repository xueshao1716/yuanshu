// New tasks always belong to a conversation run. Unbound historical launches
// retain their old stop/recovery controls without being relabelled as shared runs.
export function createTeamApi({ launcher, runApi, json }) {
  const control = action => async (res, req, body) => {
    const launch = launcher.status();
    if (!launch?.id || launch.id !== body?.id) return json(res, 409, { error: '任务状态已变化，请刷新后重试' });
    if (launch.runId) return runApi[action](res, launch.runId, req);
    const result = await launcher[action](launch.id);
    return json(res, result.status, result.body);
  };
  return {
    start(res, req, body) {
      const task = body?.task;
      if (typeof task !== 'string' || !task.trim() || task.length > 300 || /[\x00-\x1f]/.test(task)
        || !body.sessionId || !body.clientRequestId) return json(res, 400, { error: '请提供会话、请求编号和 1–300 字单行任务' });
      return runApi.create(res, { sessionId: body.sessionId, clientRequestId: body.clientRequestId, message: task.trim(), workflow: 'team-video' }, req);
    },
    stop: control('stop'),
    resume: control('resume'),
  };
}
