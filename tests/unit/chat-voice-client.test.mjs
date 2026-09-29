import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatCall, bindCallLifecycle } from '../../frontend/src/realtime/call.mjs'
import { appendTranscript } from '../../frontend/src/realtime/state.mjs'
import { callError } from '../../frontend/src/realtime/errors.ts'

function fixture(overrides = {}) {
  const sockets = [], states = [], order = []; let audio
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this) }
    send(raw) { this.sent.push(JSON.parse(raw)) } close() { this.readyState = 3 }
  }
  const call = createChatCall({ wsUrl: 'wss://chat.test/ws/chat-voice', WebSocket: Socket,
    audioFactory: async options => { order.push('audio'); audio = { options, setMuted(v) { this.muted = v }, close() { this.closed = true }, interrupt: () => ({ itemId: 'i', responseId: 'r', playedMs: 33 }), push() {} }; return audio },
    requestTicket: async id => { order.push('ticket:' + id); return { ticket: 'one-use' } },
    onState: s => states.push(s), onEvent() {}, ...overrides,
  })
  const start = () => call.start('chat', async () => { order.push('session'); return 'chat' })
  const ready = async () => { await start(); const ws = sockets[0]; ws.readyState = 1; ws.onopen(); ws.onmessage({ data: '{"type":"ready","conversationId":"chat"}' }); return ws }
  return { call, start, ready, sockets, states, order, get audio() { return audio } }
}
test('provider failures explain the actual boundary instead of a generic stopped call', () => {
  for (const code of ['provider_timeout', 'provider_connection_failed', 'provider_disconnected', 'provider_request_failed', 'connection_expired', 'slow_client', 'slow_provider', 'auth_timeout']) {
    assert.notEqual(callError(code), callError('unknown_failure'), code)
    assert.match(callError(code), /重试|重新|登录/)
  }
})

test('unrelated storage updates never hang up an active call; token changes still do', () => {
  const page = new EventTarget(), doc = new EventTarget(); let stops = 0
  const dispose = bindCallLifecycle({ stop: () => stops++ }, page, doc)
  const changed = key => { const e = new Event('storage'); Object.defineProperty(e, 'key', { value: key }); page.dispatchEvent(e) }
  changed('pi_theme'); changed('pi_last_session'); assert.equal(stops, 0)
  changed('yuanshu_access_token'); changed('pi_web_token'); changed(null); assert.equal(stops, 3)
  dispose(); changed('yuanshu_access_token'); assert.equal(stops, 4)
})
test('timeout preserves the blocked stage and offers the appropriate recovery', async () => {
  let options, grant, finished
  const stopped = new Promise(resolve => { finished = resolve })
  const f = fixture({ setupTimeoutMs: 10, audioFactory: opts => { options = opts; return new Promise(resolve => { grant = resolve }) },
    onState: state => { if (state.error) finished(state) } })
  const pending = f.start(), state = await stopped
  assert.equal(state.failureStage, 'microphone')
  assert.equal(options.signal.aborted, true)
  assert.match(callError(state.error, state.failureStage), /麦克风授权.*超时/)
  assert.doesNotMatch(callError(state.error, state.failureStage), /检查网络/)
  const late = { close() { this.closed = true } }; grant(late); await pending
  assert.equal(late.closed, true)
  for (const [stage, label] of [['audio', '音频'], ['session', '会话'], ['ticket', '凭证'], ['socket', '网络'], ['service', '服务']]) {
    assert.ok(callError('connection_timeout', stage).includes(label), stage)
  }
})

test('missing and busy microphones are not reported as network failures', async () => {
  for (const [name, code] of [['NotFoundError', 'microphone_missing'], ['NotReadableError', 'microphone_unavailable']]) {
    const f = fixture({ audioFactory: async () => { throw Object.assign(new Error('device failure'), { name }) } })
    await f.start(); assert.equal(f.states.at(-1).error, code)
    assert.doesNotMatch(callError(code), /网络/)
  }
  for (const code of ['audio_initialization_failed', 'audio_processing_failed']) assert.match(callError(code), /音频/)
})

test('no auto connection; audio initializes in click stack before session or ticket await', async () => {
  const f = fixture(); assert.equal(f.sockets.length, 0); const started = f.start()
  assert.deepEqual(f.order, ['audio']); await started
  assert.deepEqual(f.order, ['audio', 'ticket:chat']); const ws = f.sockets[0]; ws.readyState = 1; ws.onopen()
  assert.equal(ws.url, 'wss://chat.test/ws/chat-voice'); assert.deepEqual(ws.sent, [{ type: 'auth', ticket: 'one-use' }])
  f.call.stop()
})

test('startup stages expose the actual pending step and ready time without stale updates', async () => {
  let options, grant, ticket, timestamp = 1000
  const f = fixture({ now: () => timestamp,
    audioFactory: opts => { options = opts; return new Promise(resolve => { grant = resolve }) },
    requestTicket: () => new Promise(resolve => { ticket = resolve }),
  })
  const pending = f.start()
  assert.equal(f.states.at(-1).stage, 'microphone')
  assert.equal(f.states.at(-1).readyAt, null)
  timestamp = 1100; options.onStage('audio')
  assert.equal(f.states.at(-1).stage, 'audio')
  assert.equal(f.states.at(-1).timings.microphone, 100)
  grant({ close() {}, setMuted() {}, interrupt: () => ({}) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.states.at(-1).stage, 'ticket')
  ticket({ ticket: 'test' }); await pending
  assert.equal(f.states.at(-1).stage, 'socket')
  const ws = f.sockets[0]; ws.readyState = 1; ws.onopen()
  assert.equal(f.states.at(-1).stage, 'service')
  timestamp = 1500; ws.onmessage({ data: JSON.stringify({ type: 'ready', conversationId: 'chat' }) })
  assert.equal(f.states.at(-1).readyAt, 1500)
  assert.equal(f.states.at(-1).activity, 'listening')
  options.onPlayback(true); assert.equal(f.states.at(-1).activity, 'replying')
  options.onPlayback(false); assert.equal(f.states.at(-1).activity, 'listening')
  timestamp = 2500; f.call.stop(); options.onStage('audio'); options.onPlayback(true)
  assert.equal(f.states.at(-1).endedAt, 2500)
  timestamp = 4000; f.call.stop(); assert.equal(f.states.at(-1).endedAt, 2500)
  assert.equal(f.states.at(-1).stage, 'idle'); assert.equal(f.states.at(-1).activity, 'idle')
})
test('ready gates capture; mute, interrupt, hangup release resources without any task command', async () => {
  const f = fixture(); const ws = await f.ready()
  f.audio.options.onPacket(new Uint8Array([0, 0])); assert.equal(ws.sent.at(-1).type, 'audio')
  f.call.mute(); assert.equal(f.audio.muted, true); assert.equal(ws.sent.at(-1).type, 'mute')
  f.call.interrupt(); assert.equal(ws.sent.at(-1).playedMs, 33)
  f.call.stop(); assert.equal(f.audio.closed, true); assert.equal(ws.sent.at(-1).type, 'hangup'); assert.equal(f.states.at(-1).phase, 'idle')
  assert.equal(ws.sent.filter(e => e.type.startsWith('task.')).length, 0)
})

test('explicit task controls send only while ready, errors never end audio', async () => {
  const events=[], f=fixture({onEvent:e=>events.push(e)})
  assert.equal(typeof f.call.propose,'function')
  assert.equal(f.call.propose('one','任务'),false)
  const ws=await f.ready()
  assert.equal(f.call.propose('one','任务'),true)
  assert.deepEqual(ws.sent.at(-1),{type:'task.propose',requestId:'one',text:'任务'})
  assert.equal(f.call.confirm('p1',true),true)
  assert.deepEqual(ws.sent.at(-1),{type:'task.confirm',id:'p1',approved:true})
  ws.onmessage({data:JSON.stringify({type:'task.error',code:'submission_unconfirmed'})})
  assert.equal(f.states.at(-1).phase,'ready'); assert.equal(events.at(-1).type,'task.error')
  f.call.stop(); assert.equal(f.call.confirm('p1',true),false)
})
test('cancel while microphone or session is pending cannot reopen a call', async () => {
  let grant; const late = { close() { this.closed = true } }
  const f = fixture({ audioFactory: () => new Promise(r => { grant = r }) })
  const started = f.start(); f.call.stop(); grant(late); await started
  assert.equal(late.closed, true); assert.equal(f.sockets.length, 0)
  let resolve; const g = fixture(); const creating = g.call.start(null, () => new Promise(r => { resolve = r }))
  await new Promise(r => setImmediate(r)); g.call.stop(); resolve('chat'); await creating
  assert.equal(g.sockets.length, 0); assert.equal(g.audio.closed, true)
})
test('new-session binding allows its own creation but stops on another chat or empty chat', async () => {
  const f = fixture(); await f.call.start(null, async () => { f.call.sessionChanged('chat'); return 'chat' })
  assert.equal(f.sockets.length, 1); f.call.sessionChanged('other'); assert.equal(f.audio.closed, true)
  const g = fixture(); await g.ready(); g.call.sessionChanged(null); assert.equal(g.audio.closed, true)
})
test('logout, hidden page, pagehide and unmount release lifecycle handlers', () => {
  const page = new EventTarget(), doc = new EventTarget(); doc.hidden = false; let stops = 0
  const dispose = bindCallLifecycle({ stop: () => stops++ }, page, doc)
  page.dispatchEvent(new Event('yuanshu-auth-change')); page.dispatchEvent(new Event('pi-unauthorized'))
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); page.dispatchEvent(new Event('pagehide'))
  assert.equal(stops, 4); dispose(); page.dispatchEvent(new Event('pagehide')); assert.equal(stops, 5)
})
test('backlog, socket error, mismatched ready and setup timeout all fail closed', async () => {
  const f = fixture(); const ws = await f.ready(); ws.bufferedAmount = 70000
  f.audio.options.onPacket(new Uint8Array([0, 0])); assert.equal(f.audio.closed, true)
  const g = fixture(); await g.start(); g.sockets[0].onerror(); assert.equal(g.audio.closed, true)
  const h = fixture(); await h.start(); h.sockets[0].onmessage({ data: '{"type":"ready","conversationId":"other"}' }); assert.equal(h.audio.closed, true)
  const j = fixture({ setupTimeoutMs: 10 }); await j.start(); await new Promise(r => setTimeout(r, 20)); assert.equal(j.audio.closed, true)
})
test('transcripts merge assistant deltas and bound both entries and text', () => {
  let list = []; for (let i = 0; i < 200; i++) list = appendTranscript(list, { role: 'user', text: 'x'.repeat(1000) })
  assert.ok(list.length <= 40); assert.ok(list.reduce((n, m) => n + m.text.length, 0) <= 16000)
  list = appendTranscript([], { role: 'assistant', responseId: 'r', text: '你' })
  list = appendTranscript(list, { role: 'assistant', responseId: 'r', text: '好' }); assert.equal(list[0].text, '你好')
})
