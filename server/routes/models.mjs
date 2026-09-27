// 模型路由 - /api/models/*
// 模型列表、切换、管理等

/**
 * 创建模型路由处理器
 * @param {Object} deps
 * @param {Object} deps.engine - 引擎实例
 */
export function createModelRoutes({ engine }) {
  const {
    json,
    // 模型相关函数会从 server.mjs 迁移过来
  } = engine;

  return async function modelHandler(req, res, url) {
    const path = url.pathname.replace('/api/models', '');

    // GET /api/models - 列表
    if (req.method === 'GET' && path === '') {
      try {
        // TODO: 从 server.mjs 迁移模型列表逻辑
        json(res, { models: [], current: null, cwd: '' });
      } catch (err) {
        console.error('[Models] 列表错误:', err);
        json(res, { error: err.message }, 500);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未找到' }));
  };
}
