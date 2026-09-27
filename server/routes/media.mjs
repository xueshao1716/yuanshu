// 媒体路由 - /api/image, /api/video, /api/media
// 图片、视频生成

/**
 * 创建媒体路由处理器
 * @param {Object} deps
 * @param {Object} deps.engine - 引擎实例
 */
export function createMediaRoutes({ engine }) {
  const {
    handleImage,
    handleMedia,
    // 视频相关函数
  } = engine;

  return {
    image: async function imageHandler(req, res, url) {
      // TODO: 从 server.mjs 迁移图片生成逻辑
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '尚未实现' }));
    },

    video: async function videoHandler(req, res, url) {
      // TODO: 从 server.mjs 迁移视频生成逻辑
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '尚未实现' }));
    },

    media: async function mediaHandler(req, res, url) {
      // TODO: 从 server.mjs 迁移媒体路由逻辑
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '尚未实现' }));
    },
  };
}
