import { useEffect, useState } from 'react'
import { ThemeApi, ColorApi } from '../api'
import { restoreThemePreferences } from '../theme/apply'
import { applyColorCardShell, currentColorCardShell, persistColorCardShell } from '../theme/colorcard-shell.mjs'

// Hydrate before either client mounts its controls; reading preferences must never save them.
// 全局创作配色卡（左/右栏的色纱）也在这条水合路径上：晚一步应用就会闪一下原来的灰。
export function useThemePreferences(authed: boolean) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!authed) { setReady(false); return }
    let alive = true
    // 先按本地缓存立刻上色：不发请求、不会闪；接口拿到之后再以服务端那份为准。
    // （网络慢/失败时也能保住色纱——只靠接口的话一次失败就整片回到灰的。）
    applyColorCardShell(currentColorCardShell())
    // 两条水合并行：主题（界面）与全局创作配色卡（壳层色纱 + 出图色调）
    const colorReady = ColorApi.get()
      .then(prefs => { if (alive && prefs) persistColorCardShell(prefs.colorCardId || '') })
      .catch(() => {})
    const themeReady = ThemeApi.get()
      .then(preferences => { if (alive && preferences) restoreThemePreferences(preferences) })
      .catch(() => {})
    Promise.all([colorReady, themeReady]).finally(() => { if (alive) setReady(true) })
    return () => { alive = false }
  }, [authed])
  return ready
}
