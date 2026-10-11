import React from 'react'
import ReactDOM from 'react-dom/client'
import * as Tooltip from '@radix-ui/react-tooltip'
import 'virtual:uno.css'
import './styles.css'
import App from './App'
import { bootTheme } from './theme/apply'

// 非阻塞字体：由同源模块激活，兼容 CSP 禁止内联事件以及缓存命中。
const fonts = document.querySelector<HTMLLinkElement>('link[data-deferred-fonts]')
if (fonts) {
  const applyFonts = () => { fonts.media = 'all' }
  fonts.addEventListener('load', applyFonts, { once: true })
  if (fonts.sheet) applyFonts()
}

bootTheme()

// Capacitor 环境：沉浸式状态栏（targetSdk 35+ 强制 edge-to-edge）。
// setOverlaysWebView(true)：WebView 内容延伸到状态栏/刘海底下，前端用 env(safe-area-inset-top) 自动避让；
// Style.Dark 只管图标颜色（白色）。v8 的 setBackgroundColor 已移除，之前那行是空操作还把 v7 语义带偏。
import('@capacitor/status-bar').then(async ({ StatusBar, Style }) => {
  try { await StatusBar.setOverlaysWebView({ overlay: true }); } catch {}
  try { await StatusBar.setStyle({ style: Style.Dark }); } catch {}
}).catch(() => {})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Tooltip.Provider delayDuration={250} skipDelayDuration={300}>
      <App />
    </Tooltip.Provider>
  </React.StrictMode>,
)
