// engine/design-api.mjs —— 设计相关路由（画布巡检 / 设计委托 / 后台调研）
//
// 2026-10-19 伙伴问「server.mjs 是不是又变大了」：功能逻辑早已拆进 engine，
// 但路由仍堆在 server.mjs 里。这里按 companion-api.mjs 的样子把成组路由搬出来，
// 以后每加一个接口是"在这个文件加一段"，而不是继续往主文件里塞。
//
// 约定：返回 [method, path, handler] 三元组数组，由 server 的注册表统一挂。

export function createDesignRoutes({
  wsRoot,
  json,
  readBody,
  // 画布
  readCanvasDoc,
  normalizeCanvasDoc,
  auditCanvas,
  formatAudit,
  // 委托
  createCommission,
  listCommissions,
  removeCommission,
  runCommission,
  setCommissionStatus,
  pickDirection,
  // 调研
  listResearch,
  readResearch,
  runResearch,
  modelSearch = null,
  // 委托出图通道
  generateImageSaved,
} = {}) {
  const fail = (res, code, e) => json(res, code, { ok: false, error: String(e?.message || e).slice(0, 160) });

  return [
    // 画布巡检：可带前端当前文档一起核（避免等到防抖保存后才一致），不调模型、不改文档
    ['POST', '/api/canvas/audit', async (res, req) => {
      try {
        const body = await readBody(req, 1);
        const source = body?.doc && Array.isArray(body.doc.nodes) ? normalizeCanvasDoc(body.doc).doc : readCanvasDoc(wsRoot);
        const brief = body?.brief || source.brief;
        const r = await auditCanvas(source, { brief, wsRoot });
        json(res, 200, { ok: r.ok, issues: r.issues, text: formatAudit(r) });
      } catch (e) { fail(res, 500, e) }
    }],

    // 设计委托：列表/创建/试跑/暂停恢复/删除
    ['GET', '/api/design-commissions', (res) => json(res, 200, { ok: true, items: listCommissions(wsRoot) })],
    ['POST', '/api/design-commissions', async (res, req) => {
      try { json(res, 200, { ok: true, commission: createCommission(wsRoot, await readBody(req, 1)) }) }
      catch (e) { fail(res, 400, e) }
    }],
    ['POST', /^\/api\/design-commissions\/([^/]+)\/run$/, async (res, req, url, m) => {
      try {
        const r = await runCommission(wsRoot, m[1], {
          generate: generateImageSaved,
          audit: (doc, opts) => auditCanvas(doc, { ...opts, wsRoot }),
          fresh: true,
        });
        json(res, 200, r);
      } catch (e) { fail(res, 500, e) }
    }],
    ['POST', /^\/api\/design-commissions\/([^/]+)\/(pause|resume)$/, (res, req, url, m) => {
      json(res, 200, setCommissionStatus(wsRoot, m[1], m[2] === 'pause' ? 'paused' : 'running'));
    }],
    // 三方向选一：挑完还要再 run 一次出正式稿
    ['POST', /^\/api\/design-commissions\/([^/]+)\/pick$/, async (res, req, url, m) => {
      try {
        const body = await readBody(req, 0.016);
        json(res, 200, pickDirection(wsRoot, m[1], body?.index));
      } catch (e) { fail(res, 400, e) }
    }],
    ['DELETE', /^\/api\/design-commissions\/([^/]+)$/, (res, req, url, m) => json(res, 200, removeCommission(wsRoot, m[1]))],

    // 后台调研：列表/按 id 取/跑一次（十几秒，直接等结果，前端显示"调研中"）
    ['GET', '/api/design-research', (res) => json(res, 200, { ok: true, items: listResearch(wsRoot, { limit: 20 }) })],
    ['GET', /^\/api\/design-research\/([^/]+)$/, (res, req, url, m) => {
      const row = readResearch(wsRoot, m[1]);
      json(res, row ? 200 : 404, row ? { ok: true, item: row } : { ok: false, error: '没有这条调研' });
    }],
    ['POST', '/api/design-research', async (res, req) => {
      try {
        const body = await readBody(req, 0.5);
        const topic = String(body?.topic || '').trim();
        if (!topic) return json(res, 400, { ok: false, error: '缺少 topic' });
        const { ok, record } = await runResearch(wsRoot, { topic, modelSearch: typeof modelSearch === 'function' ? modelSearch() : null });
        json(res, 200, { ok, item: record });
      } catch (e) { fail(res, 500, e) }
    }],
  ];
}
