// Mounted only behind server.mjs authentication; no automatic completion/timer hooks.
export function createBehaviorExperimentRoutes({ service, json, readBody }) {
  return [
    ['GET', '/api/behavior-experiments', res => json(res, 200, service.list())],
    ['POST', '/api/behavior-experiments', async (res, req) => json(res, 200, await service.record(await readBody(req, 0.25)))],
    ['GET', /^\/api\/behavior-experiments\/([a-f0-9]{64})$/, (res, req, url, m) => json(res, 200, service.get(m[1]))],
    ['POST', /^\/api\/behavior-experiments\/([a-f0-9]{64})\/revoke$/, async (res, req, url, m) =>
      json(res, 200, await service.revoke(m[1], await readBody(req, 0.01)))],
  ];
}
