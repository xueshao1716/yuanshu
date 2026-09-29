import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { readPreference, savePreference } from './useWidgetMotion'
import { normalizeSkin } from './widget-state.mjs'
import { useCompanion } from './useCompanion'
import XiaoyuWidget from '../XiaoyuWidget'

type Companion = ReturnType<typeof useCompanion> & { skin: string; hidden: boolean; chooseSkin: (skin: string) => void; setHidden: (hidden: boolean) => void }
const CompanionContext = createContext<Companion | null>(null)

export function CompanionProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(() => readPreference('yuanshu_companion_hidden') === 'true')
  const [skin, setSkin] = useState(() => normalizeSkin(readPreference('xiaoyu_skin')))
  const chooseSkin = useCallback((next: string) => {
    const value = normalizeSkin(next)
    setSkin(value); savePreference('xiaoyu_skin', value)
  }, [])
  // The controller lives above routing so page changes do not tear down the stream,
  // emotion observation, or the draggable floating layer.
  const companion = useCompanion(true)
  const setHiddenPersisted = useCallback((next: boolean) => {
    setHidden(next)
    savePreference('yuanshu_companion_hidden', String(next))
  }, [])
  const value = useMemo(() => ({ ...companion, skin, hidden, chooseSkin, setHidden: setHiddenPersisted }), [companion, skin, hidden, chooseSkin, setHiddenPersisted])
  return <CompanionContext.Provider value={value}>
    {children}
    <XiaoyuWidget companion={companion} hidden={hidden} setHidden={setHiddenPersisted} skin={skin} chooseSkin={chooseSkin} />
  </CompanionContext.Provider>
}

export function useCompanionContext() {
  const value = useContext(CompanionContext)
  if (!value) throw new Error('useCompanionContext must be used inside CompanionProvider')
  return value
}
