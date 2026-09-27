// 聊天路由 - POST /api/chat (SSE 流式)
// 这是最核心的路由，承载对话循环

import { readBody } from '../../engine/http-utils.mjs';

/**
 * 创建聊天路由处理器
 * @param {Object} deps
 * @param {Object} deps.engine - 引擎实例
 */
export function createChatRoutes({ engine }) {
  const {
    handleUnifiedChat,
    json,
  } = engine;

  return async function chatHandler(req, res, url) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    try {
      const body = await readBody(req);
      await handleUnifiedChat(req, res, body);
    } catch (err) {
      console.error('[Chat] 错误:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || '内部错误' }));
      }
    }
  };
}
