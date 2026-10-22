// 必须最先执行：给 http 局域网补 crypto.randomUUID，否则手机端白屏
import './lib/uuid'
import React from 'react'
import ReactDOM from 'react-dom/client'
import * as Tooltip from '@radix-ui/react-tooltip'
import 'virtual:uno.css'
import './styles.css'
// 质感层：必须排在 styles.css 之后，才能覆盖层级/字阶/边界（2026-10-19）
import './premium.css'
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


ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Tooltip.Provider delayDuration={250} skipDelayDuration={300}>
      <App />
    </Tooltip.Provider>
  </React.StrictMode>,
)
