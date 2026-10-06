// 安装版快捷方式自动登录：启动器打开 http://127.0.0.1:8787/#t=<令牌>。
// 令牌放在 URL 片段里：片段不会发给服务器，不进访问日志；读完立刻从地址栏抹掉。
// 只认本机回环地址打开的页面，且只认形如十六进制的令牌，其余一律不处理。
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function readHashToken(loc) {
  if (!loc || !LOOPBACK.has(String(loc.hostname || ''))) return '';
  const m = /^#t=([0-9a-fA-F]{16,128})$/.exec(String(loc.hash || ''));
  return m ? m[1] : '';
}

/** 读到令牌就写入存储、清空远程地址（本机直连），并把片段从地址栏去掉。返回令牌或空串。 */
export function consumeHashToken({ location: loc, history: hist, storage, tokenKey, apiBaseKey } = {}) {
  const token = readHashToken(loc);
  if (!token) return '';
  try { storage?.setItem(tokenKey, token); storage?.removeItem(apiBaseKey); } catch {}
  try { hist?.replaceState(null, '', String(loc.pathname || '/') + String(loc.search || '')); } catch {}
  return token;
}
