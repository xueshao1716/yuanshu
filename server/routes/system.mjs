// 系统路由 - /api/system/*
// 系统信息、更新检查、健康检查等

/**
 * 创建系统路由处理器
 * @param {Object} deps
 * @param {Object} deps.engine - 引擎实例
 */
export function createSystemRoutes({ engine }) {
  const { json } = engine;

  return async function systemHandler(req, res, url) {
    const path = url.pathname.replace('/api/system', '');

    // GET /api/system/info - 系统信息
    if (req.method === 'GET' && path === '/info') {
      json(res, {
        version: '2.116.0',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        platform: process.platform,
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未找到' }));
  };
}
