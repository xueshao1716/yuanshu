import { useCallback, useRef, useState, type SetStateAction } from 'react'

// Hide previous data during the first render, before the loading effect runs.
// A setter captured by old asynchronous work cannot affect a new view (A→B→A).
export function useViewState<T = undefined>(owner: string, initial?: T) {
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const [state, setState] = useState({ owner, value: initial as T })
  const setValue = useCallback((update: SetStateAction<T>) => {
    if (ownerRef.current !== owner) return
    setState(previous => {
      if (ownerRef.current !== owner) return previous
      const value = previous.owner === owner ? previous.value : initial as T
      return { owner, value: typeof update === 'function' ? (update as (v: T) => T)(value) : update }
    })
  }, [owner, initial])
  return [state.owner === owner ? state.value : initial as T, setValue] as const
}
