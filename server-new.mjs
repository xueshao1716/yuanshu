#!/usr/bin/env node
// 元枢 Web 服务入口 - 精简版（拆解后）
// 职责：启动 HTTP 服务器 + 初始化引擎 + 分发请求

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import { createApp } from './server/app.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────
// 1. 引擎初始化（所有 engine/* 模块）
// ─────────────────────────────────────────────────────
// 
// 注意：这里是**过渡期方案**，暂时保留所有 engine/* 的导入。
// 最终目标：所有 engine 初始化移到 server/engine-loader.mjs，
// 这个文件只保留 < 100 行的启动逻辑。
//
// 当前先做到：
// 1. 路由逻辑物理隔离到 server/routes/*
// 2. 中间件隔离到 server/middleware/*
// 3. 新增功能只能写在 server/ 下
//
// 后续批次会把这坨 import 收进 engine-loader

import { json } from './engine/http-utils.mjs';
import { initSessionManager, createSession, getSessionList, deleteSession } from './engine/session-manager.mjs';
import { initUnifiedChat, handleUnifiedChat } from './engine/unified-chat.mjs';
import { handleWsTree, handleWsFile, handleWsRead, handleWsWrite } from './engine/workspace-api.mjs';
import { handleImage, handleMedia } from './engine/media-api.mjs';
import { handleStats } from './engine/stats-api.mjs';

console.log(`[元枢] 正在启动... (${CONFIG.port})`);

// 初始化引擎模块（部分，完整版待迁移）
initSessionManager({ cwd: CONFIG.cwd });
initUnifiedChat({ cwd: CONFIG.cwd });

// 组装引擎对象（传给 app）
const engine = {
  publicDir: path.join(__dirname, 'public'),
  json,
  createSession,
  getSessionList,
  deleteSession,
  handleUnifiedChat,
  handleWsTree,
  handleWsFile,
  handleWsRead,
  handleWsWrite,
  handleImage,
  handleMedia,
  handleStats,
  // ... 更多函数会在迁移时逐步加入
};

// ─────────────────────────────────────────────────────
// 2. 创建应用实例
// ─────────────────────────────────────────────────────
const app = createApp({ config: CONFIG, engine });

// ─────────────────────────────────────────────────────
// 3. 启动 HTTP 服务器
// ─────────────────────────────────────────────────────
const server = http.createServer(app);

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[元枢] 服务已启动 http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`[元枢] 工作目录: ${CONFIG.cwd}`);
  console.log(`[元枢] 访问令牌: ${CONFIG.token.slice(0, 8)}...`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[元枢] 收到 SIGTERM 信号，正在关闭...');
  server.close(() => {
    console.log('[元枢] 服务已停止');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[元枢] 收到 SIGINT 信号，正在关闭...');
  server.close(() => {
    console.log('[元枢] 服务已停止');
    process.exit(0);
  });
});
