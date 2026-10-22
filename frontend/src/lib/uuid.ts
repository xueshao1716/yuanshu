// 2026-10-22：局域网 http 下 crypto.randomUUID 不存在（只有 HTTPS/localhost 才有），
// 手机扫码登录后被重定向到首页会直接白屏（TypeError: crypto.randomUUID is not a function）。
// 这里先补一个安全回退，再让业务代码统一用 uuid()。
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
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

// 第三方代码/库也可能直接调 crypto.randomUUID，所以补到全局上（失败也不影响业务）
try {
  const c = globalThis.crypto as unknown as { randomUUID?: () => string } | undefined
  if (c && typeof c.randomUUID !== 'function') c.randomUUID = () => uuid()
} catch { /* 有些环境 crypto 是只读的，忽略 */ }
