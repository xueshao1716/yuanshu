import { useSyncExternalStore } from 'react'

type Kind = 'tools' | 'evidence'
const prefix = 'yuanshu_process_visibility_v1_'
const listeners = new Set<() => void>()
const values: Record<Kind, boolean> = { tools: true, evidence: false }
const loaded = new Set<Kind>()

function snapshot(kind: Kind) {
  if (!loaded.has(kind) && typeof window !== 'undefined') {
    loaded.add(kind)
    try {
      const saved = localStorage.getItem(prefix + kind)
      if (saved === 'true' || saved === 'false') values[kind] = saved === 'true'
    } catch { /* Restricted storage: retain in-memory preference. */ }
  }
  return values[kind]
}
function onStorage(event: StorageEvent) {
  for (const kind of ['tools', 'evidence'] as const) {
    if (event.key !== null && event.key !== prefix + kind) continue
    loaded.delete(kind)
    values[kind] = kind === 'tools'
  }
  listeners.forEach(listener => listener())
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}
export function useProcessVisibility(kind: Kind): [boolean, () => void] {
  const visible = useSyncExternalStore(subscribe, () => snapshot(kind), () => kind === 'tools')
  return [visible, () => {
    values[kind] = !snapshot(kind)
    try { localStorage.setItem(prefix + kind, String(values[kind])) } catch { /* Memory fallback. */ }
    listeners.forEach(listener => listener())
  }]
}
