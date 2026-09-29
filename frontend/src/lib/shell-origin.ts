/** 手机壳加载的是包内页面，origin 不是电脑上的 8787。 */

export function isBundledShellOrigin(origin = ''): boolean {
  const o = String(origin || '').toLowerCase()
  return o.startsWith('tauri:')
    || o.includes('tauri.localhost')
    || o.startsWith('capacitor:')
    || o.startsWith('https://asset.localhost')
}

function isPhoneLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}

/** 壳内必须填电脑可达地址；浏览器打开 8787 时仍可留空走本机。 */
export function mobileApiBaseError(apiBase: string, pageOrigin = ''): string {
  if (!isBundledShellOrigin(pageOrigin)) return ''
  const base = String(apiBase || '').trim()
  if (!base) return '手机端必须填写电脑的服务器地址，不能留空'
  if (!/^https?:\/\//i.test(base)) return '服务器地址要以 http:// 或 https:// 开头'
  if (isPhoneLoopback(base)) return '127.0.0.1 是手机自己，请填电脑局域网 IP 或可访问的 HTTPS 地址'
  return ''
}
