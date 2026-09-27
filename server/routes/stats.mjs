// 统计路由 - /api/stats/*
// 使用统计、性能指标等

/**
 * 创建统计路由处理器
 * @param {Object} deps
 * @param {Object} deps.engine - 引擎实例
 */
export function createStatsRoutes({ engine }) {
  const { handleStats } = engine;

  return async function statsHandler(req, res, url) {
    // TODO: 从 server.mjs 迁移统计路由逻辑
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '尚未实现' }));
  };
}
