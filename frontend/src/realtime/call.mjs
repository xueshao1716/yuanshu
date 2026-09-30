import { createVoiceAudio } from './audio.mjs'

export function createChatCall({ wsUrl, requestTicket, onState, onEvent, workletUrl,
  WebSocket: Socket = globalThis.WebSocket, audioFactory = createVoiceAudio, setupTimeoutMs = 45000, now = Date.now }) {
  let socket, audio, controller, timeout, phase = 'idle', muted = false, generation = 0
  let boundId = null, creating = false, observedId = null
  let stage = 'idle', activity = 'idle', startedAt = null, readyAt = null, endedAt = null, stageStartedAt = null, timings = {}
  let failureStage = null
  const state = error => onState({ phase, muted, error, stage, failureStage, activity, startedAt, readyAt, endedAt, stageStartedAt, timings: { ...timings } })
  function advance(next) {
    const at = now()
    if (stageStartedAt !== null) timings[stage] = Math.max(0, at - stageStartedAt)
    stage = next; stageStartedAt = at; state()
  }
  function stop(error) {
    failureStage = error ? stage : null
    if (phase !== 'idle') endedAt = now()
    generation++; clearTimeout(timeout); controller?.abort(); controller = null; audio?.close(); audio = null
    const old = socket; socket = null
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      if (old.readyState === 1) { try { old.send(JSON.stringify({ type: 'hangup' })) } catch {} }
      old.close()
    }
    phase = 'idle'; stage = 'idle'; activity = 'idle'; muted = false; boundId = null; creating = false; state(error)
  }
  function send(event) {
    if (phase !== 'ready' || socket?.readyState !== 1) return false
    if (socket.bufferedAmount > 64000) { stop('connection_slow'); return false }
    try { socket.send(JSON.stringify(event)); return true } catch { stop('connection_failed'); return false }
  }
  function interrupt() {
    if (phase !== 'ready') return
    try { send({ type: 'interrupt', ...audio.interrupt() }) } catch { stop('playback_queue_limit') }
  }
  return {
    async start(sessionId, ensureSession, modelKey) {
      if (phase !== 'idle') return
      const run = ++generation; controller = new AbortController(); phase = 'connecting'; boundId = sessionId || null
      observedId = boundId; creating = !boundId
      startedAt = now(); readyAt = null; endedAt = null; failureStage = null; stageStartedAt = null; timings = {}; activity = 'idle'; advance('microphone')
      timeout = setTimeout(() => stop('connection_timeout'), setupTimeoutMs)
      try {
        const fresh = await audioFactory({ signal: controller.signal, workletUrl,
          onStage: next => { if (run === generation && phase === 'connecting') advance(next) },
          onPlayback: playing => { if (run === generation && phase === 'ready') { activity = playing ? 'replying' : 'listening'; state() } },
          onFailure: code => { if (run === generation) stop(code) },
          onPacket: bytes => { if (run === generation) send({ type: 'audio', data: btoa(String.fromCharCode(...bytes)) }) } })
        if (run !== generation) { fresh.close(); return }
        audio = fresh
        if (!boundId) advance('session')
        const id = boundId || await ensureSession?.()
        if (run !== generation) return
        if (!id || (creating && observedId && observedId !== id)) { stop('conversation_changed'); return }
        boundId = id; creating = false
        advance('ticket')
        const { ticket } = await requestTicket(id, controller.signal, modelKey)
        if (run !== generation) return
        advance('socket')
        socket = new Socket(wsUrl); const current = socket
        current.onopen = () => {
          if (run !== generation) return
          try { current.send(JSON.stringify({ type: 'auth', ticket })); advance('service') } catch { stop('connection_failed') }
        }
        current.onerror = () => { if (run === generation) stop('connection_failed') }
        current.onclose = () => { if (run === generation) stop('connection_closed') }
        current.onmessage = ({ data }) => {
          if (run !== generation) return
          try {
            if (typeof data !== 'string' || data.length > 1500000) throw new Error('invalid_frame')
            const event = JSON.parse(data)
            if (event.type === 'ready') {
              if (event.conversationId !== boundId) { stop('conversation_changed'); return }
              if (phase !== 'ready') { clearTimeout(timeout); phase = 'ready'; readyAt = now(); activity = 'listening'; audio.setMuted(false); advance('ready') }
            } else if (event.type === 'audio' && phase === 'ready') audio.push(event)
            else if (event.type === 'speech.started' && phase === 'ready') { interrupt(); if (phase === 'ready') { activity = 'hearing'; state() } }
            else if (event.type === 'speech.stopped' && phase === 'ready') { activity = 'listening'; state() }
            else if (event.type === 'error') { stop(event.code || 'connection_failed'); return }
            onEvent(event)
          } catch { stop('audio_protocol_failed') }
        }
      } catch (error) {
        const deviceErrors = { NotAllowedError: 'microphone_denied', NotFoundError: 'microphone_missing',
          NotReadableError: 'microphone_unavailable', OverconstrainedError: 'microphone_unavailable' }
        if (run === generation) stop(deviceErrors[error?.name] || error?.message || 'microphone_failed')
      }
    },
    sessionChanged(id) {
      if (phase === 'idle') return
      if (creating) { observedId = id || null; return }
      if (id !== boundId) stop('conversation_changed')
    },
    mute() { if (phase !== 'ready') return; muted = !muted; audio.setMuted(muted); if (muted) send({ type: 'mute' }); state() },
    propose(requestId, text) { return send({ type: 'task.propose', requestId, text }) },
    confirm(id, approved) { return send({ type: 'task.confirm', id, approved }) },
    interrupt, stop,
  }
}

export function bindCallLifecycle(call, page = window, doc = document) {
  const stop = () => call.stop(), hidden = () => { if (doc.hidden) stop() }
  const storage = event => { if (event.key === null || ['yuanshu_access_token', 'pi_web_token'].includes(event.key)) stop() }
  const events = ['yuanshu-auth-change', 'pi-unauthorized', 'pagehide']
  page.addEventListener('storage', storage)
  events.forEach(name => page.addEventListener(name, stop)); doc.addEventListener('visibilitychange', hidden)
  return () => { events.forEach(name => page.removeEventListener(name, stop)); page.removeEventListener('storage', storage); doc.removeEventListener('visibilitychange', hidden); stop() }
}
