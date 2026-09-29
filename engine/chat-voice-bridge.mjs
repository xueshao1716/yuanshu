import { WebSocketServer } from 'ws'
import { voiceSession, createProviderEvents } from './chat-voice-provider.mjs'
import { createChatVoiceTools, taskTools, taskInstructions } from './chat-voice-tools.mjs'

const MAX_QUEUE = 512 * 1024
export function attachChatVoice({ server, admission, readSession, origins, connect, runtime, canAccess,
  authTimeoutMs = 5000, setupTimeoutMs = 15000, maxCallMs = 25 * 60000, maxPending = 8, onDiagnostic = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false })
  let pending = 0
  function upgrade(req, socket, head) {
    if (req.url?.split('?')[0] !== '/ws/chat-voice') return
    if (req.url !== '/ws/chat-voice' || !origins.includes(req.headers.origin)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
    if (pending >= maxPending) { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return }
    try { wss.handleUpgrade(req, socket, head, ws => { pending++; wss.emit('connection', ws) }) } catch { socket.destroy() }
  }
  server.on('upgrade', upgrade)
  wss.on('connection', client => {
    let upstream, protocol, tasks, claim, leased = false, isPending = true, ready = false, closed = false, frames = 0, bytes = 0, windowAt = Date.now()
    let alive = true
    const connectedAt = Date.now(), recovered = new Set()
    let stage = 'auth', endCode = 'client_closed'
    const diagnostic = (event, code) => {
      try { onDiagnostic({ event, stage, code, elapsedMs: Math.max(0, Date.now() - connectedAt) }) } catch {}
    }
    const timers = new Set()
    const later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); timers.add(t); return t }
    const releasePending = () => { if (isPending) { pending--; isPending = false } }
    function cleanup() {
      if (closed) return
      closed = true; releasePending(); for (const t of timers) clearTimeout(t); clearInterval(heartbeat)
      diagnostic('ended', endCode)
      if (leased) admission.release(claim)
      tasks?.close()
      upstream?.terminate()
    }
    function end(code) {
      if (closed) return
      endCode = code
      if (client.readyState === 1 && client.bufferedAmount <= MAX_QUEUE) client.send(JSON.stringify({ type: 'error', code }))
      cleanup(); client.close(1008, code); const t = setTimeout(() => client.terminate(), 1000); t.unref?.()
    }
    function emit(event) {
      if (closed || client.readyState !== 1) return
      if (client.bufferedAmount > MAX_QUEUE) return end('slow_client')
      client.send(JSON.stringify(event))
    }
    function send(event) {
      if (closed || upstream?.readyState !== 1) return
      if (upstream.bufferedAmount > MAX_QUEUE) return end('slow_provider')
      upstream.send(JSON.stringify(event))
    }
    const authTimer = later(() => end('auth_timeout'), authTimeoutMs)
    const heartbeat = setInterval(() => {
      if (!alive || (claim && !admission.valid(claim))) return end('connection_expired')
      alive = false; if (client.readyState === 1) client.ping()
    }, 15000); heartbeat.unref?.()
    client.on('pong', () => { alive = true })
    client.on('error', cleanup); client.on('close', cleanup)
    client.on('message', (raw, binary) => {
      if (closed) return
      try {
        if (binary || raw.length > 65536) return end('invalid_frame')
        if (Date.now() - windowAt >= 1000) { windowAt = Date.now(); frames = 0; bytes = 0 }
        if (++frames > 80 || (bytes += raw.length) > 180000) return end('rate_limit')
        const e = JSON.parse(raw)
        if (!leased) {
          if (e?.type !== 'auth' || !(claim = admission.consume(e.ticket))) return end('unauthorized')
          if (!admission.acquire(claim)) return end('call_busy')
          leased = true; releasePending(); clearTimeout(authTimer)
          stage = 'service'
          const context = readSession(claim.conversationId)
          if (!context) return end('conversation_gone')
          upstream = connect()
          const setup = later(() => end('provider_timeout'), setupTimeoutMs)
          later(() => end('call_time_limit'), maxCallMs)
          if (runtime) tasks = createChatVoiceTools({ runtime, conversationId: claim.conversationId,
            canAccess: id => admission.valid(claim) && canAccess?.(id) === true, emit,
            reply: (id, result) => protocol.toolResult(id, result) })
          protocol = createProviderEvents({ context, emit, send, end, onToolCall: tasks ? e => tasks.call(e) : undefined, onReady: () => {
            if (ready) return
            clearTimeout(setup); ready = true; stage = 'ready'; diagnostic('ready')
            emit({ type: 'ready', conversationId: claim.conversationId, sampleRate: 24000 })
          }, onRecoverableError: code => { if (!recovered.has(code)) { recovered.add(code); diagnostic('recovered', code) } } })
          upstream.on('open', () => {
            diagnostic('provider_connected')
            send({ type: 'session.update', session: tasks ? { ...voiceSession, tools: taskTools, instructions: taskInstructions } : voiceSession })
          })
          upstream.on('error', () => end('provider_connection_failed'))
          upstream.on('close', () => end('provider_disconnected'))
          upstream.on('message', (rawProvider, providerBinary) => {
            if (closed) return
            try {
              if (providerBinary || rawProvider.length > 1024 * 1024) return end('provider_frame_limit')
              protocol.receive(JSON.parse(rawProvider))
            } catch { end('provider_protocol_failed') }
          })
          return
        }
        if (e.type === 'hangup') { endCode = 'hangup'; cleanup(); client.close(1000); return }
        if (!ready) return end('not_ready')
        if (e.type === 'audio') {
          if (typeof e.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(e.data) || e.data.length % 4 || Buffer.from(e.data, 'base64').length % 2) return end('invalid_audio')
          send({ type: 'input_audio_buffer.append', audio: e.data })
        } else if (e.type === 'mute') send({ type: 'input_audio_buffer.clear' })
        else if (e.type === 'interrupt') protocol.interrupt(e)
        else if (tasks && ['task.propose', 'task.confirm'].includes(e.type)) {
          const action = e.type === 'task.propose' ? tasks.propose(e) : tasks.confirm(e)
          void action.catch(() => emit({ type: 'task.error', code: 'proposal_rejected' }))
        }
        else end('unsupported_event')
      } catch { end(leased && !upstream ? 'provider_unavailable' : 'client_request_rejected') }
    })
  })
  return { close() { server.off('upgrade', upgrade); for (const client of wss.clients) client.terminate(); wss.close() } }
}
