export function normalizeWorkspaceUrl(value) {
  const raw = String(value || '').trim();
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(candidate); } catch { throw new Error('请输入有效的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('地址只能是远程 HTTP(S) 站点，不能带路径、参数或令牌');
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('手机不能使用本机回环地址，请填写电脑局域网或公网地址');
  return url.origin + '/';
}

if (typeof document !== 'undefined') {
  const form = document.querySelector('#connect-form');
  const input = document.querySelector('#workspace-url');
  const error = document.querySelector('#error');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try { window.location.assign(normalizeWorkspaceUrl(input.value)); }
    catch (e) { error.textContent = e?.message || '地址无效'; input.focus(); }
  });
}
