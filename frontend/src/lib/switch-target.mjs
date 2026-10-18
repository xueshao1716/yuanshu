// 账号管理"切换"的目标判定（2026-10-18）。
//
// 原来的切换只是把 apiBase/token 写进 localStorage 再 location.reload()：
// reload 不改变地址栏，页面仍由当前源提供，所以切到"别的元枢"时地址没变——是个样子货。
// 元枢是自带前端的整体应用（静态资源、SSE、相对 URL 都在本地源），
// 因此真正的切换必须是**浏览器跳转**到那台实例的地址。
//
// 令牌只能在回环地址上用 ?t= 带过去（服务端只对本机回环消费它，避免令牌经链接泄漏）；
// 远程实例首次访问需要在那边输入一次令牌，之后由那个源的 localStorage 记住。

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * @param {{apiBase?: string, token?: string, currentHref?: string}} input
 * @returns {{kind: 'reload'} | {kind: 'navigate', url: string, tokenInQuery: boolean, local: boolean}}
 */
export function resolveSwitchTarget({apiBase = '', token = '', currentHref = ''} = {}) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  if (!base) return {kind: 'reload'}; // 本机服务：沿用当前源，只换令牌

  let target = null;
  try { target = new URL(base); } catch { return {kind: 'navigate', url: base, tokenInQuery: false, local: false}; }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return {kind: 'navigate', url: base, tokenInQuery: false, local: false};
  }

  let currentOrigin = '';
  try { currentOrigin = new URL(currentHref).origin; } catch {}
  if (target.origin === currentOrigin) return {kind: 'reload'}; // 同一个实例，刷新即可

  const local = LOOPBACK.has(target.hostname);
  // 只有回环地址能带令牌：远程地址带过去既不会被消费，又会把令牌留在地址栏里。
  const url = local && token
    ? `${target.origin}/?t=${encodeURIComponent(token)}`
    : `${target.origin}/`;
  return {kind: 'navigate', url, tokenInQuery: local && !!token, local};
}
