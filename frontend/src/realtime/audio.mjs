import { createPlayback } from './playback.mjs'

export async function createVoiceAudio({ onPacket, onFailure = () => {}, onStage = () => {}, onPlayback = () => {}, signal, workletUrl = new URL('./capture-worklet.mjs', import.meta.url).href }, env = globalThis) {
  if (env.isSecureContext === false) throw new Error('secure_context_required')
  if (!env.navigator?.mediaDevices?.getUserMedia || !env.AudioContext || !env.AudioWorkletNode) throw new Error('audio_not_supported')
  let context
  try { context = new env.AudioContext({ latencyHint: 'interactive' }) }
  catch { throw new Error('audio_initialization_failed') }
  let stream, source, capture, silent, playback, closed = false, muted = true, epoch = 0
  function close() {
    if (closed) return
    closed = true; context.onstatechange = null; signal?.removeEventListener('abort', close)
    stream?.getTracks().forEach(track => { track.onended = null; track.stop() }); playback?.close()
    if (capture) { capture.port.onmessage = null; capture.disconnect() }
    source?.disconnect(); silent?.disconnect()
    if (context.state !== 'closed') void context.close().catch(() => {})
  }
  signal?.addEventListener('abort', close, { once: true })
  try {
    if (signal?.aborted) { close(); throw new Error('call_cancelled') }
    // Both calls run in the user's click stack. Neither permission nor audio
    // activation waits on the other; Promise.all observes both rejections.
    const permission = (async () => {
      const granted = await env.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      if (closed) { granted.getTracks().forEach(track => track.stop()); throw new Error('call_cancelled') }
      stream = granted
      stream.getTracks().forEach(track => { track.enabled = false; track.onended = () => { if (!closed) onFailure('microphone_disconnected') } })
      onStage('audio')
    })()
    const activation = (async () => {
      try { await context.resume() } catch { throw new Error('audio_initialization_failed') }
    })()
    await Promise.all([permission, activation])
    if (closed) throw new Error('call_cancelled')
    try { await context.audioWorklet.addModule(workletUrl) } catch { throw new Error('audio_processing_failed') }
    if (closed) throw new Error('call_cancelled')
    capture = new env.AudioWorkletNode(context, 'yuanshu-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    source = context.createMediaStreamSource(stream); silent = context.createGain(); silent.gain.value = 0
    source.connect(capture); capture.connect(silent); silent.connect(context.destination)
    playback = createPlayback(context, onPlayback)
    context.onstatechange = () => { if (!closed && context.state !== 'running') onFailure('audio_interrupted') }
    capture.onprocessorerror = () => onFailure('audio_processing_failed')
    capture.port.onmessage = ({ data }) => { if (!closed && !muted && data.epoch === epoch) onPacket(data.bytes) }
    return {
      setMuted(value) {
        if (closed) return
        muted = value; epoch++; stream.getTracks().forEach(track => { track.enabled = !muted })
        capture.port.postMessage({ enabled: !muted, epoch })
      },
      push: event => playback.push(event), interrupt: () => playback.interrupt(), close,
    }
  } catch (error) { close(); throw error }
}
