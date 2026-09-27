// 工作空间路由 - /api/ws/*
// 文件树、读写、搜索等

/**
 * 创建工作空间路由处理器
 * @param {Object} deps
 * @param {Object} deps.engine - 引擎实例
 */
export function createWorkspaceRoutes({ engine }) {
  const {
    handleWsTree,
    handleWsFile,
    handleWsRead,
    handleWsWrite,
    // 其他工作空间函数
  } = engine;

  return async function workspaceHandler(req, res, url) {
    // TODO: 从 server.mjs 迁移工作空间路由逻辑
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '尚未实现' }));
  };
}
