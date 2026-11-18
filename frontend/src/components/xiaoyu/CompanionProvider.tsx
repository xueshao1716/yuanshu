import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { readPreference, savePreference } from './useWidgetMotion'
import { normalizeSkin } from './widget-state.mjs'
import { useCompanion } from './useCompanion'
import XiaoyuWidget from '../XiaoyuWidget'

type Companion = ReturnType<typeof useCompanion> & { skin: string; hidden: boolean; enabled: boolean; chooseSkin: (skin: string) => void; setHidden: (hidden: boolean) => void; setEnabled: (enabled: boolean) => void }
const CompanionContext = createContext<Companion | null>(null)

export function CompanionProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(() => readPreference('yuanshu_companion_hidden') === 'true')
  // 总开关：关掉后桌面上连收起的小圆钮也不留（hidden 只是收起）。只影响本机。
  const [enabled, setEnabled] = useState(() => readPreference('yuanshu_companion_enabled') !== 'false')
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
  const setEnabledPersisted = useCallback((next: boolean) => {
    setEnabled(next)
    savePreference('yuanshu_companion_enabled', String(next))
  }, [])
  const value = useMemo(() => ({ ...companion, skin, hidden, enabled, chooseSkin, setHidden: setHiddenPersisted, setEnabled: setEnabledPersisted }), [companion, skin, hidden, enabled, chooseSkin, setHiddenPersisted, setEnabledPersisted])
  return <CompanionContext.Provider value={value}>
    {children}
    {enabled && <XiaoyuWidget companion={companion} hidden={hidden} setHidden={setHiddenPersisted} skin={skin} chooseSkin={chooseSkin} />}
  </CompanionContext.Provider>
}

export function useCompanionContext() {
  const value = useContext(CompanionContext)
  if (!value) throw new Error('useCompanionContext must be used inside CompanionProvider')
  return value
}
