import { useSyncExternalStore } from 'react'
import { createSpeechOutput } from './speech-output.mjs'
import { createCloudSpeech } from './cloud-speech.mjs'
import { createStreamingSpeech } from './streaming-speech.mjs'
import { createIncrementalSpeech } from './incremental-speech.mjs'
import { consumeSpeechStream } from './speech-stream-transport.mjs'
import { apiUrl, getToken } from '../api'
import { audioFocus } from '../realtime/focus.mjs'
import { createDeviceVoices } from './speech-voices.mjs'

const deviceVoices = createDeviceVoices({
  synth: typeof window === 'undefined' ? undefined : window.speechSynthesis,
  storage: { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) },
})
const device = createSpeechOutput({
  synth: typeof window === 'undefined' ? undefined : window.speechSynthesis,
  Utterance: typeof window === 'undefined' ? undefined : window.SpeechSynthesisUtterance,
  getVoice: deviceVoices.getVoice,
})
const cloud = createCloudSpeech({
  Audio: typeof window === 'undefined' ? undefined : window.Audio,
  createUrl: (blob: Blob) => URL.createObjectURL(blob), revokeUrl: (url: string) => URL.revokeObjectURL(url),
  synthesize: async (text: string, { signal }: { signal: AbortSignal }) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) controller.abort()
    const timer = setTimeout(abort, 65000)
    try {
      const response = await fetch(apiUrl('/api/tts'), { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ text }) })
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error || `语音请求失败（${response.status}）`) }
      const blob = await response.blob()
      if (!blob.size || !blob.type.startsWith('audio/')) throw new Error('服务未返回有效音频，请重试。')
      return blob
    } catch (error) {
      if (controller.signal.aborted && !signal.aborted) throw new Error('语音合成超时，请点击朗读重试。')
      throw error
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  },
})
const streamingCloud = createStreamingSpeech({
  synthesize: async (text: string, { signal, onAudio }: { signal: AbortSignal; onAudio: (event: { data: string; sampleRate: number }) => void }) => {
    const controller = new AbortController(), abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) controller.abort()
    const timer = setTimeout(abort, 70000)
    try {
      const response = await fetch(apiUrl('/api/tts/stream'), { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ text }) })
      await consumeSpeechStream(response, { signal: controller.signal, onAudio })
    } catch (error) {
      if (controller.signal.aborted && !signal.aborted) throw new Error('流式朗读超时，可在回复完成后点击朗读重试。')
      throw error
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  },
})
type Mode = 'device' | 'cloud'
let options = { mode: (device.supported ? 'device' : 'cloud') as Mode, available: false, streaming: false, loading: true, model: '', voice: '', voiceLabel: '', error: '' }
let chosen = false, refreshId = 0
const optionListeners = new Set<() => void>()
const publishOptions = () => optionListeners.forEach(fn => fn())
let streamingActive = false
const current = () => options.mode === 'cloud' ? streamingActive ? streamingCloud : cloud : device
const incremental = createIncrementalSpeech({ output: {
  begin: (id: string) => { streamingActive = true; cloud.stop(); (options.mode === 'cloud' ? streamingCloud : device).begin(id) },
  append: (text: string) => (options.mode === 'cloud' ? streamingCloud : device).append(text),
  finish: () => (options.mode === 'cloud' ? streamingCloud : device).finish(),
  stop: () => {
    if (!streamingActive) return
    streamingActive = false; device.stop(); streamingCloud.stop()
  },
} })
const canReadLive = () => autoSpeechEnabled() && !audioFocus.isBusy() &&
  (options.mode !== 'cloud' || (options.available && options.streaming && streamingCloud.supported))
export const speech = {
  get supported() { return options.mode === 'cloud' ? options.available && cloud.supported : device.supported },
  get streamingSupported() { return options.mode === 'cloud' ? options.available && options.streaming && streamingCloud.supported : device.supported },
  speak: (id: string, text: string) => {
    if (options.mode === 'cloud' && !options.available) { void refreshSpeechOptions(); return }
    incremental.stop(); streamingActive = false
    return (options.mode === 'cloud' ? cloud : device).speak(id, text)
  },
  updateReply: (id: string, text: string) => { if (canReadLive()) incremental.update(id, text); else incremental.skip(id) },
  finishReply: (id: string, text: string) => { if (canReadLive()) incremental.finish(id, text); else incremental.skip(id) },
  skipReply: (id: string) => incremental.skip(id),
  stop: () => { incremental.stop(); device.stop(); streamingCloud.stop(); cloud.stop() },
  pause: () => current().pause(), resume: () => current().resume(),
  setRecording: (value: boolean) => { if (value) incremental.stop(); device.setRecording(value); cloud.setRecording(value); streamingCloud.setRecording(value) },
  getSnapshot: () => current().getSnapshot(),
  subscribe: (fn: () => void) => {
    const offDevice = device.subscribe(fn), offCloud = cloud.subscribe(fn), offStream = streamingCloud.subscribe(fn)
    optionListeners.add(fn)
    return () => { offDevice(); offCloud(); offStream(); optionListeners.delete(fn) }
  },
}
const setSpeechRecording = speech.setRecording.bind(speech)
speech.setRecording = (value: boolean) => audioFocus.setRecorder(value)
audioFocus.subscribe(() => setSpeechRecording(audioFocus.isBusy()))
export function setSpeechMode(mode: Mode) {
  speech.stop(); setAutoSpeech(false); chosen = true; options = { ...options, mode }; publishOptions()
}
export async function refreshSpeechOptions() {
  const id = ++refreshId
  options = { ...options, loading: true, error: '' }; publishOptions()
  try {
    const response = await fetch(apiUrl('/api/tts/capabilities'), { headers: { Authorization: `Bearer ${getToken()}` }, signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error('无法检查云端语音，请重试')
    const data = await response.json()
    if (id !== refreshId) return
    options = { ...options, available: Boolean(data.available), streaming: Boolean(data.streaming), model: data.model || '', loading: false,
      voice: data.voice || '', voiceLabel: data.voiceLabel || '',
      error: data.available ? '' : data.reason || '尚未配置阶跃语音模型',
      mode: !chosen && !device.supported ? 'cloud' : options.mode }
  } catch (error) {
    if (id !== refreshId) return
    options = { ...options, loading: false, available: false, streaming: false, error: (error as Error).message }
  }
  publishOptions()
}
export const deviceSpeechSupported = device.supported
export const useDeviceVoices = () => useSyncExternalStore(deviceVoices.subscribe, deviceVoices.getSnapshot)
export function setDeviceVoice(id: string) {
  if (audioFocus.isCallActive()) return
  if (deviceVoices.select(id)) speech.stop()
}
export const useSpeechOptions = () => useSyncExternalStore(
  fn => { optionListeners.add(fn); return () => { optionListeners.delete(fn) } }, () => options,
)
// Deliberately per-page opt-in: restoring preferences must not start unexpected audio.
let auto = false
const listeners = new Set<() => void>()
export const autoSpeechEnabled = () => auto
export function setAutoSpeech(value: boolean) {
  auto = value && !audioFocus.isCallActive() && speech.streamingSupported
  if (!auto) speech.stop()
  else if (options.mode === 'cloud') streamingCloud.unlock()
  listeners.forEach(fn => fn())
}
type SpeechSnapshot = { id: string; status: string; error: string }
export const useSpeech = () => useSyncExternalStore<SpeechSnapshot>(speech.subscribe, speech.getSnapshot)
export const useAutoSpeech = () => useSyncExternalStore(
  fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, autoSpeechEnabled,
)
