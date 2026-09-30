// All APIs below are synthetic; callers must block cross-origin requests.
export function knowledgeFixture() {
  const state = {failReads: false, failModels: true, denySource: true, intakeError: '', jobs: [], counts: new Map(), writes: []};
  state.policy = {revision: 1, localEnabled: true, paused: false, remoteEnabled: false, networkEnabled: false,
    dailyCost: 0, currency: 'USD', maxModelRequests: 20, maxNetworkRequests: 20, inputTokens: 6000, outputTokens: 1200,
    allowedRoots: ['docs'], allowedUrls: [], allowedModels: [], outboundRoots: [], model: '', rates: {}};
  state.job = (i, extra = {}) => ({id: `fixture-${i}`, title: `隔离资料 ${i}`, state: 'queued', stage: 'queued', revision: 1,
    createdAt: 1790755200000, sources: [{kind: 'file', path: `docs/source-${i}.txt`, hash: 'a'.repeat(64)}], ...extra});
  state.respond = async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    state.counts.set(p, (state.counts.get(p) || 0) + 1);
    const send = (json, status = 200) => route.fulfill({json, status});
    if (req.method() !== 'GET') {
      const data = req.postDataJSON(); state.writes.push({path: p, data});
      if (p === '/api/knowledge/policy') {
        if (data.revision !== state.policy.revision) return send({error: 'revision_conflict'}, 409);
        state.policy = {...state.policy, ...data.patch, revision: state.policy.revision + 1};
        return send(state.policy);
      }
      if (p === '/api/knowledge/enqueue') {
        if (state.denySource) return send({error: 'source_not_authorized'}, 403);
        return send(state.job(30, {title: '新登记来源'}));
      }
      const match = p.match(/^\/api\/knowledge\/jobs\/([^/]+)\/(control|review)$/);
      if (match) {
        const job = state.jobs.find(j => j.id === match[1]);
        if (!job || data.revision !== job.revision) return send({error: 'revision_conflict'}, 409);
        if (match[2] === 'review' && (!data.confirmed || !data.note.trim() || data.policyRevision !== state.policy.revision)) return send({error: 'invalid_review'}, 400);
        job.revision++; job.state = match[2] === 'review' ? 'queued' : data.action === 'pause' ? 'paused' : 'queued';
        return send(job);
      }
      return send({error: 'fixture_readonly'}, 405);
    }
    if (state.failReads && (p.startsWith('/api/knowledge/') || ['/api/refine/status','/api/learning-intake/status'].includes(p))) return send({error: 'knowledge_unavailable'}, 503);
    if (p === '/api/knowledge/status') return send({summary: {counts: state.jobs.reduce((counts, job) => {
      const key = job.displayState || job.state; counts[key] = (counts[key] || 0) + 1; return counts;
    }, {}), total: state.jobs.length, paused: state.policy.paused, policyRevision: state.policy.revision},
      worker: {running: false, cooldownUntil: 0}, budget: {day: '2026-09-30', currency: 'USD', spent: 0, reserved: 0, unknown: 0, modelRequests: 0, networkRequests: 0}, intake: {lastError: state.intakeError}});
    if (p === '/api/knowledge/policy') return send(state.policy);
    if (p === '/api/knowledge/models') return state.failModels ? send({error: 'knowledge_unavailable'}, 503) : send([{key: 'fixture/text', label: '隔离文本模型'}]);
    if (p === '/api/knowledge/jobs') {const offset = Number(url.searchParams.get('offset')); return send({items: state.jobs.slice(offset, offset + 20), total: state.jobs.length});}
    if (p.startsWith('/api/knowledge/jobs/')) return send(state.jobs.find(j => j.id === p.split('/').at(-1)) || {});
    return send(p === '/api/sessions' ? {sessions: [{id: 'fixture', name: '测试会话', group: 'workspace'}]}
      : p === '/api/models' ? {models: [], cwd: 'fixture'}
      : p === '/api/time/tasks' ? {tasks: []}
      : p === '/api/run/overview' ? {active: [], recent: [], health: {status: 'idle', activeCount: 0, failedCount: 0}}
      : p.endsWith('/messages') ? {messages: [], truncated: false}
      : p === '/api/refine/list' ? {pending: [], applied: [], rejected: []}
      : p === '/api/refine/status' ? {counts: {pending: 0, applied: 0, rejected: 0}, experience: {count: 0, entries: []}}
      : {});
  };
  return state;
}
