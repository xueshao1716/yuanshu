// 助理卡片开关（2026-11-23）：放在模块里而不是 AppLayout 的 state。
// 原因：登录态就绪前后 AppLayout 可能整体重挂，卡片跟着 state 走的话，
// 冷启动刚拉起来就被重建成关闭态——用户看到的就是「点磁贴只打开了 App」。
let open = false
const subs = new Set()

export function isAssistOpen() { return open }

export function openAssist() {
  if (open) return
  open = true
  subs.forEach(fn => { try { fn(true) } catch {} })
}

export function closeAssist() {
  if (!open) return
  open = false
  subs.forEach(fn => { try { fn(false) } catch {} })
}

export function subscribeAssist(fn) {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/**
 * 安卓壳把「未消费的唤起意图」存在内存里（MainActivity 的 YuanshuFlash），
 * 页面挂好之后主动来取。磁贴点下去时 Activity 先起来、页面还在冷启动，
 * 纯推送派发要赌时序，取一次则跟先后无关。浏览器里没有这个接口，返回空串。
 */
export function takeNativePending() {
  try { return window.YuanshuFlash?.takePending?.() || '' } catch { return '' }
}

/** 告诉原生「事件收到了」，它就不用再重发。 */
export function markNativeConsumed() {
  try { window.YuanshuFlash?.consumed?.() } catch {}
}
