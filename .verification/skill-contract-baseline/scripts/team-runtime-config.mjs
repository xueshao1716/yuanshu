import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultWorkspace } from '../engine/workspace-default.mjs';

export function loadTeamRuntimeConfig({ env = process.env, repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), readTokenFile = file => fs.readFileSync(file, 'utf8') } = {}) {
  const wsRoot = path.resolve(env.YUANSHU_CWD || env.PI_WEB_CWD || env.PI_WORKSPACE || defaultWorkspace());
  let url;
  try {
    url = new URL(env.YUANSHU_TEAM_BASE_URL || `http://127.0.0.1:${env.YUANSHU_PORT || env.PI_WEB_PORT || 8787}`);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
  } catch { throw new Error('天团服务地址必须是本机 HTTP 回环地址'); }
  const token = String(env.YUANSHU_TOKEN ?? env.PI_WEB_TOKEN ?? readTokenFile(path.join(repoRoot, '.token'))).trim();
  if (!token) throw new Error('缺少元枢访问凭据');
  return { wsRoot, teamRoot: path.join(wsRoot, '工程', '多AI角色扮演系统'), baseUrl: url.origin, token };
}
