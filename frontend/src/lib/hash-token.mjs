// 安装版快捷方式自动登录：启动器打开 http://127.0.0.1:8787/?t=<令牌>。
// 令牌放在 query 参数里（不用 hash fragment），避免令牌中含 # 被浏览器截断。
// query 参数不会发给静态文件服务器（SPA 拦截前），读完立刻从地址栏抹掉。
// 只认本机回环地址打开的页面，其余一律不处理。
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function readHashToken(loc) {
  if (!loc || !LOOPBACK.has(String(loc.hostname || ''))) return '';
  // 优先读 query 参数 ?t=（新格式，兼容含 # 的 token）
  try {
    const sp = new URLSearchParams(String(loc.search || ''));
    const qt = sp.get('t');
    if (qt && qt.length >= 8) return qt;
  } catch {}
  // 兼容旧格式 hash fragment #t=（token 为纯十六进制时仍可用）
  const raw = String(loc.hash || '');
  const m = /^#t=([0-9a-fA-F]{16,128})$/.exec(raw);
  return m ? m[1] : '';
}

/** 读到令牌就写入存储、清空远程地址（本机直连），并把片段从地址栏去掉。返回令牌或空串。 */
export function consumeHashToken({ location: loc, history: hist, storage, tokenKey, apiBaseKey } = {}) {
  const token = readHashToken(loc);
  if (!token) return '';
  try { storage?.setItem(tokenKey, token); storage?.removeItem(apiBaseKey); } catch {}
  // 清掉 ?t= 参数和 hash，避免令牌留在地址栏
  try {
    const sp = new URLSearchParams(String(loc.search || ''));
    sp.delete('t');
    const qs = sp.toString() ? '?' + sp.toString() : '';
    hist?.replaceState(null, '', String(loc.pathname || '/') + qs);
  } catch {}
  return token;
}
