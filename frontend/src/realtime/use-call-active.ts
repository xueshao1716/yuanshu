import { useSyncExternalStore } from 'react'
import { audioFocus } from './focus.mjs'
export const useCallActive = () => useSyncExternalStore<boolean>(audioFocus.subscribe, audioFocus.isCallActive)
