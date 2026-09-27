// 会话路由 - /api/sessions/*
// 会话的 CRUD、重命名、导出等

import { readBody } from '../../engine/http-utils.mjs';

/**
 * 创建会话路由处理器
 * @param {Object} deps
 * @param {Object} deps.engine - 引擎实例
 */
export function createSessionRoutes({ engine }) {
  const {
    json,
    createSession,
    getSessionList,
    deleteSession,
    // 其他会话相关函数会逐步从 server.mjs 迁移过来
  } = engine;

  return async function sessionHandler(req, res, url) {
    const path = url.pathname.replace('/api/sessions', '');

    // GET /api/sessions - 列表
    if (req.method === 'GET' && path === '') {
      try {
        const sessions = await getSessionList();
        json(res, { sessions });
      } catch (err) {
        console.error('[Sessions] 列表错误:', err);
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // POST /api/sessions - 创建
    if (req.method === 'POST' && path === '') {
      try {
        const body = await readBody(req);
        const data = JSON.parse(body);
        const session = await createSession(data.name || '新会话');
        json(res, session);
      } catch (err) {
        console.error('[Sessions] 创建错误:', err);
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // DELETE /api/sessions/:id - 删除
    const deleteMatch = path.match(/^\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const sessionId = deleteMatch[1];
      try {
        await deleteSession(sessionId);
        json(res, { ok: true });
      } catch (err) {
        console.error('[Sessions] 删除错误:', err);
        json(res, { error: err.message }, 500);
      }
      return;
    }

    // 其他会话路由（rename/export/messages 等）稍后迁移
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未找到' }));
  };
}
