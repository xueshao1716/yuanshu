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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Tooltip.Provider delayDuration={250} skipDelayDuration={300}>
      <App />
    </Tooltip.Provider>
  </React.StrictMode>,
)
