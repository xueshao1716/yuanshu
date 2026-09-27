// 元枢 HTTP 应用核心 —— 路由总装配
// 这个文件负责：初始化所有能力模块 → 创建路由表 → 返回请求处理函数
// server.mjs 只负责启动 HTTP 服务器，所有业务逻辑在这里组装

import { createChatRoutes } from './routes/chat.mjs';
import { createSessionRoutes } from './routes/sessions.mjs';
import { createModelRoutes } from './routes/models.mjs';
import { createWorkspaceRoutes } from './routes/workspace.mjs';
import { createMediaRoutes } from './routes/media.mjs';
import { createSystemRoutes } from './routes/system.mjs';
import { createStatsRoutes } from './routes/stats.mjs';
import { createAuthMiddleware } from './middleware/auth.mjs';
import { createCorsMiddleware } from './middleware/cors.mjs';
import { createStaticHandler } from './middleware/static.mjs';

/**
 * 创建元枢应用实例
 * @param {Object} deps - 依赖注入
 * @param {Object} deps.config - 配置对象
 * @param {Object} deps.engine - 引擎实例（所有 engine/* 模块的集合）
 * @returns {Function} 请求处理函数 (req, res) => void
 */
export function createApp({ config, engine }) {
  // 1. 初始化中间件
  const authMiddleware = createAuthMiddleware({ token: config.token });
  const corsMiddleware = createCorsMiddleware({ 
    origins: config.corsOrigins,
    host: config.host 
  });
  const staticHandler = createStaticHandler({ publicDir: engine.publicDir });

  // 2. 初始化路由组
  const chatRoutes = createChatRoutes({ engine });
  const sessionRoutes = createSessionRoutes({ engine });
  const modelRoutes = createModelRoutes({ engine });
  const workspaceRoutes = createWorkspaceRoutes({ engine });
  const mediaRoutes = createMediaRoutes({ engine });
  const systemRoutes = createSystemRoutes({ engine });
  const statsRoutes = createStatsRoutes({ engine });

  // 3. 路由表（按优先级排序）
  const routes = [
    // API 路由（需要鉴权）
    { path: '/api/chat', handler: chatRoutes, auth: true },
    { path: '/api/sessions', handler: sessionRoutes, auth: true },
    { path: '/api/models', handler: modelRoutes, auth: true },
    { path: '/api/ws', handler: workspaceRoutes, auth: true },
    { path: '/api/image', handler: mediaRoutes.image, auth: true },
    { path: '/api/video', handler: mediaRoutes.video, auth: true },
    { path: '/api/media', handler: mediaRoutes.media, auth: true },
    { path: '/api/system', handler: systemRoutes, auth: true },
    { path: '/api/stats', handler: statsRoutes, auth: true },
    // 静态文件（无需鉴权）
    { path: '/static', handler: staticHandler, auth: false },
    { path: '/', handler: staticHandler, auth: false },
  ];

  // 4. 主请求处理器
  return async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // CORS 预检
    if (req.method === 'OPTIONS') {
      corsMiddleware(req, res);
      return;
    }

    // 应用 CORS 头
    corsMiddleware(req, res);

    // 路由匹配
    for (const route of routes) {
      if (!url.pathname.startsWith(route.path)) continue;

      // 鉴权检查
      if (route.auth) {
        const authResult = authMiddleware(req, res);
        if (!authResult) return; // 鉴权失败，中间件已发送响应
      }

      // 调用路由处理器
      try {
        await route.handler(req, res, url);
        return;
      } catch (err) {
        console.error(`[App] 路由错误 ${route.path}:`, err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '内部错误' }));
        }
        return;
      }
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未找到' }));
  };
}
