/**
 * 手机壳原生后台推送桥（Capacitor / Tauri Android 两壳同名同契约：window.YuanshuPush）。
 * App 进入后台后 Android 会冻结 WebView，页面里的通知 SSE 随之停摆；原生前台服务据此自己连
 * /api/notify/stream 并弹系统通知。网页/桌面端没有这个对象，所有调用静默跳过。
 */
type PushBridge = { configure?: (baseUrl: string, token: string) => void; clear?: () => void; ack?: (seq: number) => void }
const bridge = (): PushBridge | undefined => (globalThis as { YuanshuPush?: PushBridge }).YuanshuPush

/** 登录后把服务器地址和令牌交给原生服务（幂等：同样的参数不会重连）。 */
export function syncNativePush(baseUrl: string, token: string) {
  try { if (baseUrl && token) bridge()?.configure?.(baseUrl.replace(/\/+$/, ''), token) } catch {}
}

/** 退出登录：停掉原生监听并清掉它保存的令牌。 */
export function clearNativePush() {
  try { bridge()?.clear?.() } catch {}
}

/** 页面已处理这条通知：原生那边不必再弹一次（去重）。 */
export function ackNativePush(seq: number) {
  try { bridge()?.ack?.(seq) } catch {}
}
