// 鉴权中间件 - Bearer Token 验证

/**
 * 创建鉴权中间件
 * @param {Object} options
 * @param {string} options.token - 访问令牌
 * @returns {Function} 中间件函数
 */
export function createAuthMiddleware({ token }) {
  return function authMiddleware(req, res) {
    const auth = req.headers.authorization || '';
    const providedToken = auth.replace(/^Bearer\s+/i, '');

    if (providedToken !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未授权' }));
      return false;
    }

    return true;
  };
}
