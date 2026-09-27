import { useSyncExternalStore } from 'react'
import { createSpeechOutput } from './speech-output.mjs'

export const speech = createSpeechOutput({
  synth: typeof window === 'undefined' ? undefined : window.speechSynthesis,
  Utterance: typeof window === 'undefined' ? undefined : window.SpeechSynthesisUtterance,
})
// Deliberately per-page opt-in: restoring preferences must not start unexpected audio.
let auto = false
const listeners = new Set<() => void>()
export const autoSpeechEnabled = () => auto
export function setAutoSpeech(value: boolean) {
  auto = value
  if (!value) speech.stop()
  listeners.forEach(fn => fn())
}
type SpeechSnapshot = { id: string; status: string; error: string }
export const useSpeech = () => useSyncExternalStore<SpeechSnapshot>(speech.subscribe, speech.getSnapshot)
export const useAutoSpeech = () => useSyncExternalStore(
  fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, autoSpeechEnabled,
)
