// 静态文件中间件 - 服务 public/ 目录

import fs from 'node:fs';
import path from 'node:path';

/**
 * 创建静态文件处理器
 * @param {Object} options
 * @param {string} options.publicDir - public 目录路径
 * @returns {Function} 处理函数
 */
export function createStaticHandler({ publicDir }) {
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
  };

  return function staticHandler(req, res, url) {
    // 移除 /static 前缀
    let filePath = url.pathname.replace(/^\/static/, '');
    
    // 根路径 → index.html
    if (filePath === '/' || filePath === '') {
      filePath = '/index.html';
    }

    // 拼接完整路径
    const fullPath = path.join(publicDir, filePath);

    // 安全检查：防止路径穿越
    if (!fullPath.startsWith(publicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // 读取文件
    fs.readFile(fullPath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
        return;
      }

      // 根据扩展名设置 Content-Type
      const ext = path.extname(fullPath);
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  };
}
