// 2026-10-22：局域网 http 下 crypto.randomUUID 不存在（只有 HTTPS/localhost 才有），
// 手机扫码登录后被重定向到首页会直接白屏（TypeError: crypto.randomUUID is not a function）。
// 这里提供 uuid() 与全局回退；注意回退实现本身**不能**再走 randomUUID，否则递归爆栈。

function fallbackUuid(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (typeof c?.getRandomValues === 'function') {
    const b = new Uint8Array(16)
    c.getRandomValues(b)
    b[6] = (b[6] & 0x0f) | 0x40 // version 4
    b[8] = (b[8] & 0x3f) | 0x80 // variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// 先记录"原生有没有"，再决定是否安装回退——避免自己调用自己
const cryptoObj = globalThis.crypto as unknown as { randomUUID?: () => string } | undefined
const hasNative = !!cryptoObj && typeof cryptoObj.randomUUID === 'function'
if (cryptoObj && !hasNative) {
  try { cryptoObj.randomUUID = fallbackUuid } catch { /* 有些环境 crypto 只读，忽略 */ }
}

export function uuid(): string {
  const c = globalThis.crypto as unknown as { randomUUID?: () => string } | undefined
  const fn = c?.randomUUID
  // 原生与回退都能用；只有"既没有原生、也没装成回退"时才走本地回退
  if (typeof fn === 'function' && fn !== fallbackUuid) {
    try { return fn.call(c) } catch { /* 落到回退 */ }
  }
  return fallbackUuid()
}
