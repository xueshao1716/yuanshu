import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRunStore } from '../../engine/run-store.mjs';
import { createRunEventLog } from '../../engine/run-event-log.mjs';
import { createTaskEvidence } from '../../engine/task-evidence.mjs';
import { createTaskEvidenceApi } from '../../engine/task-evidence-api.mjs';
import { evolutionStatus, runEvolutionCycle } from '../../engine/evolution-cycle.mjs';
import { json, readBody } from '../../engine/http-utils.mjs';

// Actual evidence service and HTTP handlers, isolated from the production server.
export async function evidenceFixture(dist, extension) {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-browser-'));
  const rootDir = path.join(wsRoot, 'runtime'), token = 'isolated-test-token';
  const store = createRunStore({ rootDir }), log = createRunEventLog({ rootDir });
  const service = createTaskEvidence({ wsRoot, rootDir });
  const cycle = () => runEvolutionCycle({ wsRoot, taskEvidence: service, candidates: [], rank: () => [], fresh: true });
  const api = createTaskEvidenceApi({ service, json, onReview: cycle });
  fs.mkdirSync(path.join(wsRoot, '生成物'));
  const image = path.join(wsRoot, '生成物', 'sample.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const runs = {};
  for (const kind of ['image', 'text', 'document', 'code', 'team']) {
    const run = store.create({ sessionId: 'fixture', clientRequestId: kind, message: `隔离验收 ${kind}`, ...(kind === 'team' ? { workflow: 'team-video' } : {}) });
    runs[kind] = run.id;
    const emit = (type, data) => log.append({ runId: run.id, sessionId: run.sessionId, type, data });
    emit('tool', { id: 'skill', name: 'activate_skill', args: { name: 'fixture-skill' } });
    emit('tool_end', { id: 'skill', name: 'activate_skill', isError: false, output: 'loaded' });
    emit('delta', { text: '这是隔离环境的交付内容，供界面验收测试。' });
    if (kind === 'image') emit('file', { path: '生成物/sample.png' });
    if (['document', 'code'].includes(kind)) {
      const relative = `生成物/sample.${kind === 'code' ? 'mjs' : 'md'}`;
      fs.writeFileSync(path.join(wsRoot, relative), kind === 'code' ? 'export const answer = 42;' : '# 隔离文档');
      emit('file', { path: relative });
    }
    store.update(run.id, { status: 'completed' });
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'), p = url.pathname;
      if (p.startsWith('/api/')) {
        if (req.headers.authorization !== `Bearer ${token}` && !(p === '/api/ws/file' && url.searchParams.get('token') === token)) return json(res, 401, { error: 'unauthorized' });
        if (extension && await extension(req, res, p)) return;
        if (p === '/api/dream/evidence' && req.method === 'GET') return api.list(res);
        const match = p.match(/^\/api\/dream\/evidence\/([a-zA-Z0-9_-]+)$/);
        if (match && req.method === 'GET') return api.get(res, match[1]);
        if (match && req.method === 'POST') return await api.review(res, match[1], await readBody(req, 0.02));
        if (p === '/api/dream/status') return json(res, 200, { evolution: evolutionStatus(wsRoot, { taskEvidence: service }) });
        if (p === '/api/dream/run' && req.method === 'POST') return json(res, 200, await cycle());
        if (p === '/api/ws/file' && url.searchParams.get('path') === '生成物/sample.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(fs.readFileSync(image));
        }
        if (req.method !== 'GET') return json(res, 405, { error: 'Unrelated mutations are disabled in the fixture' });
        if (p === '/api/sessions') return json(res, 200, { sessions: [] });
        if (p === '/api/run/overview') return json(res, 200, { active: [], recent: [] });
        return json(res, 200, {});
      }
      const relative = p === '/' ? 'index.html' : decodeURIComponent(p).slice(1);
      const file = path.resolve(dist, relative);
      if (!file.startsWith(path.resolve(dist) + path.sep)) return json(res, 403, {});
      const contentType = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType }); res.end(fs.readFileSync(file));
    } catch (e) { if (!res.headersSent) json(res, e.statusCode || 500, { error: e.message }); else res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, token, service, runs, image,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(wsRoot, { recursive: true, force: true }); } };
}
