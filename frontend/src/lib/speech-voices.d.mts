export type DeviceVoice = { id: string; name: string; lang: string }
export type DeviceVoiceSnapshot = { voices: DeviceVoice[]; selected: string }
export function createDeviceVoices(options?: {
  synth?: SpeechSynthesis
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}): {
  getSnapshot: () => DeviceVoiceSnapshot
  getVoice: () => SpeechSynthesisVoice | null
  select: (id: string) => boolean
  subscribe: (listener: () => void) => () => void
}
