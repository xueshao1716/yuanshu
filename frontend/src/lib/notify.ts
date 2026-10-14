/**
 * 跨端"任务完成"系统通知统一封装
 * - Android（Capacitor/Tauri 移动壳）：走 window.YuanshuBridge.notify()（原生桥，已实现）
 * - Windows（Tauri 桌面壳）：走 window.__TAURI__.core.invoke('plugin:notification|...')（tauri-plugin-notification）
 * - 纯浏览器网页版：两者都没有，静默跳过（不报错，不影响其他逻辑）
 */

let permissionChecked = false
let permissionGranted = false

function getTauriInvoke(): ((cmd: string, args?: any) => Promise<any>) | null {
  const t = (window as any).__TAURI__
  return t?.core?.invoke || null
}

/** 检查/请求 Windows 端系统通知权限（只做一次，结果缓存） */
async function ensureTauriPermission(): Promise<boolean> {
  const invoke = getTauriInvoke()
  if (!invoke) return false
  if (permissionChecked) return permissionGranted
  permissionChecked = true
  try {
    const granted = await invoke('plugin:notification|is_permission_granted')
    if (granted) { permissionGranted = true; return true }
    const perm = await invoke('plugin:notification|request_permission')
    permissionGranted = perm === 'granted'
    return permissionGranted
  } catch (e) {
    console.warn('[notify] Windows 通知权限检查失败:', e)
    return false
  }
}

/**
 * 发送"任务完成"系统通知（三端通用入口）
 * 调用方无需关心当前是浏览器/Windows/Android，内部自动路由到可用的通道
 */
const recentKeys = new Map<string, number>()
const DEDUPE_MS = 30_000

/** 同一件事（同一会话的同一次完成）短时间内只弹一次：页面内完成提示和服务端主动通知会撞车。 */
function seenRecently(key?: string): boolean {
  if (!key) return false
  const now = Date.now()
  for (const [k, at] of recentKeys) if (now - at > DEDUPE_MS) recentKeys.delete(k)
  if (recentKeys.has(key)) return true
  recentKeys.set(key, now)
  return false
}

/** 网页版：用户在某次点击后授权一次，之后后台标签页也能弹系统通知。 */
export function armBrowserNotifications() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
  const ask = () => { try { void Notification.requestPermission() } catch {} }
  document.addEventListener('click', ask, { once: true })
}

export async function notifyTaskDone(title: string, body: string, dedupeKey?: string) {
  if (seenRecently(dedupeKey)) return
  // Android 原生桥（已有实现，触发条件由调用方控制）
  try {
    const bridge = (window as any).YuanshuBridge
    if (bridge?.notify) { bridge.notify(title, body); return }
  } catch {}

  // Windows Tauri 插件
  const invoke = getTauriInvoke()
  if (invoke) {
    try {
      const ok = await ensureTauriPermission()
      if (ok) {
        await invoke('plugin:notification|notify', { options: { title, body } })
      }
    } catch (e) {
      console.warn('[notify] Windows 系统通知发送失败:', e)
    }
    return
  }
  // 纯浏览器：已授权就弹系统通知，没授权则依赖页面内提示音 + toast
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body })
  } catch {}
}
