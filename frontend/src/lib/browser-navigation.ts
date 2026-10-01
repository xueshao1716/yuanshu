type BrowserHost = {
  __TAURI__?: { core?: { invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown> } }
  __TAURI_INTERNALS__?: unknown
  open?: (url: string, target: string) => Window | null
}

export function resolveBrowserUrl(value: string, base = globalThis.location?.href): string | null {
  const raw = value.trim()
  if (!raw) return null
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(raw)
  const candidate = raw.startsWith('/') ? raw : local ? `http://${raw}`
    : /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`
  try {
    const parsed = new URL(candidate, base)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null
  } catch { return null }
}

/** Keep the workbench alive; never navigate its main WebView to untrusted content. */
export async function openBrowserUrl(url: string, host: BrowserHost = globalThis as BrowserHost): Promise<void> {
  if (!/^https?:\/\//i.test(url) || !resolveBrowserUrl(url)) throw new Error('只支持 http(s) 链接')
  if (host.__TAURI__ || host.__TAURI_INTERNALS__) {
    try {
      const invoke = host.__TAURI__?.core?.invoke
      if (!invoke) throw new Error('bridge unavailable')
      await invoke('plugin:opener|open_url', { url })
      return
    } catch { throw new Error('未能打开系统浏览器，请更新客户端后重试，或复制地址打开。') }
  }
  // Open synchronously within the click gesture and sever opener before navigating.
  const popup = host.open?.('about:blank', '_blank')
  if (!popup) throw new Error('新窗口被浏览器拦截，请允许弹出窗口，或复制地址打开。')
  try { popup.opener = null; popup.location.replace(url) }
  catch { popup.close(); throw new Error('未能打开新窗口，请复制地址打开。') }
}
