export function createAudioFocus() {
  let recorder = false, call = false
  const listeners = new Set()
  const notify = () => listeners.forEach(fn => fn())
  return {
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    isBusy: () => recorder || call, isCallActive: () => call,
    setRecorder(value) { recorder = value; notify() },
    acquireCall() { if (recorder || call) return false; call = true; notify(); return true },
    releaseCall() { call = false; notify() },
  }
}
export const audioFocus = createAudioFocus()
