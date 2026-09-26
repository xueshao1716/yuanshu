import React from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { AppProvider, useApp } from '../../../frontend/src/store'
import SandboxModePanel from '../../../frontend/src/components/engine/SandboxModePanel'
import '../../../frontend/src/styles.css'
import 'virtual:uno.css'

function Fixture() {
  const { selectSession } = useApp()
  return <main className="max-w-3xl mx-auto p-4 bg-pi-bg text-pi-text">
    <label>测试会话<select aria-label="测试会话" onChange={e => selectSession(e.target.value || null)}><option value="">无会话</option><option>A</option><option>B</option></select></label>
    <SandboxModePanel />
  </main>
}
createRoot(document.getElementById('root')!).render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}><AppProvider><Fixture /></AppProvider></SWRConfig>)
