import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { readPreference, savePreference } from './useWidgetMotion'
import { useCompanion } from './useCompanion'
import XiaoyuWidget from '../XiaoyuWidget'

type Companion = ReturnType<typeof useCompanion>
const CompanionContext = createContext<Companion | null>(null)

export function CompanionProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(() => readPreference('yuanshu_companion_hidden') === 'true')
  // The controller lives above routing so page changes do not tear down the stream,
  // emotion observation, or the draggable floating layer.
  const companion = useCompanion(true)
  const value = useMemo(() => companion, [companion])
  const setHiddenPersisted = (next: boolean) => {
    setHidden(next)
    savePreference('yuanshu_companion_hidden', String(next))
  }
  return <CompanionContext.Provider value={value}>
    {children}
    <XiaoyuWidget companion={companion} hidden={hidden} setHidden={setHiddenPersisted} />
  </CompanionContext.Provider>
}

export function useCompanionContext() {
  const value = useContext(CompanionContext)
  if (!value) throw new Error('useCompanionContext must be used inside CompanionProvider')
  return value
}
