// 在系统层打开外部链接：桌面(Tauri)→系统默认浏览器；手机(Capacitor)→Custom Tab；
// 纯网页→新标签。替代已下线的内置浏览器面板（2026-10-12）。

type TauriHost = { __TAURI__?: { core?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<unknown> } } }
type CapacitorHost = { Capacitor?: { isNativePlatform?: () => boolean } }

export type OpenExternalVia = 'system-browser' | 'custom-tab' | 'new-tab'

export async function openExternal(rawUrl: string, host: (TauriHost & CapacitorHost) = globalThis as never): Promise<OpenExternalVia> {
  const url = String(rawUrl || '')
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http(s) 链接')
  // 桌面壳：withGlobalTauri 注入全局，opener 插件走系统默认浏览器（capabilities: browser-links）
  const tauri = (host as TauriHost).__TAURI__?.core?.invoke
  if (tauri) {
    await tauri('plugin:opener|open_url', { url })
    return 'system-browser'
  }
  // 手机壳：Capacitor Custom Tab，顶部自带“完成”一键回 app（@capacitor/browser）
  const cap = (host as CapacitorHost).Capacitor
  if (cap?.isNativePlatform?.()) {
    const { Browser } = await import('@capacitor/browser')
    await Browser.open({ url })
    return 'custom-tab'
  }
  window.open(url, '_blank', 'noopener,noreferrer')
  return 'new-tab'
}
