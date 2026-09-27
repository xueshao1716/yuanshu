// CORS 中间件 - 跨域请求处理

/**
 * 创建 CORS 中间件
 * @param {Object} options
 * @param {string} options.origins - 允许的源（逗号分隔）
 * @param {string} options.host - 监听地址
 * @returns {Function} 中间件函数
 */
export function createCorsMiddleware({ origins, host }) {
  // 解析允许的源
  const allowedOrigins = origins
    ? origins.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // 如果监听 0.0.0.0（局域网模式），默认允许所有源
  const allowAll = host === '0.0.0.0' || allowedOrigins.includes('*');

  return function corsMiddleware(req, res) {
    const origin = req.headers.origin || '';

    if (allowAll) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (origin) {
      // 默认策略：同源放行（127.0.0.1 / localhost）
      if (origin.includes('127.0.0.1') || origin.includes('localhost')) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');

    // OPTIONS 预检请求直接返回
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return false; // 停止后续处理
    }

    return true;
  };
}
