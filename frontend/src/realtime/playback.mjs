import { pcm16ToFloat } from '../lib/realtime-pcm.mjs'

// AudioContext render time runs ahead of the speaker; truncate against the output clock.
export function createPlayback(context, onPlaying = () => {}) {
  let nextAt = 0, closed = false, last = null
  const segments = [], blocked = new Set(), offsets = new Map(), playing = new Set()
  function clock() {
    const timestamp = context.getOutputTimestamp?.()
    return timestamp?.contextTime > 0 ? timestamp.contextTime : Math.max(0, context.currentTime - (context.baseLatency || 0) - (context.outputLatency || 0))
  }
  function prune() {
    const now = clock()
    while (segments.length && segments[0].end <= now) last = segments.shift()
  }
  function stop() {
    const wasPlaying = playing.size > 0
    playing.clear()
    for (const segment of segments) { try { segment.source.stop() } catch {} segment.source.disconnect() }
    segments.length = 0; offsets.clear(); nextAt = 0; last = null
    if (wasPlaying) onPlaying(false)
  }
  return {
    push(event) {
      if (closed || blocked.has(event.responseId)) return false
      if (typeof event.data !== 'string' || event.data.length > 1400000) throw new Error('invalid_audio')
      const bytes = Uint8Array.from(atob(event.data), c => c.charCodeAt(0)), samples = pcm16ToFloat(bytes)
      if (!samples.length) return false
      prune()
      const at = Math.max(context.currentTime + 0.03, nextAt), duration = samples.length / 24000
      if (at + duration - clock() > 30 || segments.length >= 2000) throw new Error('playback_queue_limit')
      if (!offsets.has(event.itemId) && offsets.size >= 256) throw new Error('response_limit')
      const offset = offsets.get(event.itemId) || 0
      const buffer = context.createBuffer(1, samples.length, 24000); buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination)
      source.onended = () => { source.disconnect(); if (playing.delete(source) && playing.size === 0) onPlaying(false) }
      const segment = { source, start: at, end: at + duration, offset, responseId: event.responseId, itemId: event.itemId }
      segments.push(segment); offsets.set(event.itemId, offset + duration); nextAt = segment.end
      const first = playing.size === 0; playing.add(source); source.start(at)
      if (first) onPlaying(true)
      return true
    },
    interrupt() {
      prune()
      const now = clock(), segment = segments.find(s => s.start <= now && s.end > now) || segments[0] || last
      for (const s of segments) blocked.add(s.responseId)
      if (segment) blocked.add(segment.responseId)
      if (blocked.size > 256) { stop(); throw new Error('response_limit') }
      const cursor = segment ? { responseId: segment.responseId, itemId: segment.itemId, playedMs: Math.max(0, segment.offset + Math.min(segment.end - segment.start, Math.max(0, now - segment.start))) * 1000 } : {}
      stop(); return cursor
    },
    close() { closed = true; stop(); blocked.clear() },
  }
}
