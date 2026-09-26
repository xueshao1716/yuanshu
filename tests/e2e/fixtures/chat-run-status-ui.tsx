import React from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import ChatRunStatus from '../../../frontend/src/components/ChatRunStatus'
import '../../../frontend/src/styles.css'
import 'virtual:uno.css'

createRoot(document.getElementById('root')!).render(
  <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
    <main className="max-w-3xl mx-auto p-4 bg-pi-bg text-pi-text">
      <ChatRunStatus sessionId="fixture" onStop={() => {}} onRetry={() => {}} />
    </main>
  </SWRConfig>,
)
