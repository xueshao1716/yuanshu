import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once, EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { attachChatVoice } from '../../engine/chat-voice-bridge.mjs'
import { createVoiceAdmission } from '../../engine/chat-voice-admission.mjs'
import { createVoiceTicketHandler } from '../../engine/chat-voice-api.mjs'
import { createProviderEvents } from '../../engine/chat-voice-provider.mjs'
import { createVoiceModelRegistry, DEFAULT_VOICE_MODEL } from '../../engine/voice-model-registry.mjs'

async function fixture(t, options = {}) {
  const providers = [], clients = [], messages = new Map(); let exists = true
  const readSession = () => exists ? [{ role: 'user', content: 'hello' }] : null
  const admission = createVoiceAdmission({ getToken: () => 'secret', readSession })
  const handler = createVoiceTicketHandler({ admission, origins: ['https://chat.test'] })
  const server = http.createServer(handler)
  const connect = modelKey => {
    const p = new EventEmitter(); p.readyState = 1; p.bufferedAmount = 0; p.sent = []; p.dead = false
    p.send = value => p.sent.push(JSON.parse(value)); p.terminate = () => { p.dead = true }
    p.modelKey = modelKey; providers.push(p); queueMicrotask(() => p.emit('open')); return p
  }
  const bridge = attachChatVoice({ server, admission, readSession, origins: ['https://chat.test'], connect, ...options })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const open = async (origin = 'https://chat.test') => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/chat-voice', { headers: origin ? { Origin: origin } : {} })
    clients.push(ws); messages.set(ws, []); ws.on('message', b => messages.get(ws).push(JSON.parse(b)))
    await once(ws, 'open'); return ws
  }
  t.after(async () => { for (const c of clients) c.terminate(); bridge.close(); await new Promise(resolve => server.close(resolve)) })
  const ticket = () => admission.issue({ headers: { authorization: 'Bearer secret' } }, 'chat').ticket
  const auth = async () => { const ws = await open(); ws.send(JSON.stringify({ type: 'auth', ticket: ticket() })); await until(() => providers.length); return ws }
  return { open, providers, ticket, auth, base, messages, remove: () => { exists = false } }
}
const until = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)) } throw new Error('condition timeout') }
const event = (p, obj) => p.emit('message', Buffer.from(JSON.stringify(obj)))

test('selected model crosses HTTP ticket, one-use claim and upstream connector', async t => {
  const f = await fixture(t), modelKey = 'stepfun-plan/stepaudio-2.5-realtime'
  const post = body => fetch(f.base + '/api/voice/ticket', { method: 'POST',
    headers: { Authorization: 'Bearer secret', Origin: 'https://chat.test' }, body: JSON.stringify(body) })
  const response = await post({ conversationId: 'chat', modelKey })
  assert.equal(response.status, 200)
  const { ticket } = await response.json(), ws = await f.open()
  ws.send(JSON.stringify({ type: 'auth', ticket }))
  await until(() => f.providers.length === 1)
  assert.equal(f.providers[0].modelKey, modelKey)
})

test('configuration revoked after ticket issuance fails safely and releases the call lease', async t => {
  let enabled = true, attempts = 0
  const registry = createVoiceModelRegistry({ readAuth: () => enabled ? { 'stepfun-plan': { key: 'fixture-key' } } : {} })
  const f = await fixture(t, { connect: key => { attempts++; registry.resolve(key); throw new Error('fixture-unavailable') } })
  const ticket = f.ticket(); enabled = false
  const ws = await f.open(); ws.send(JSON.stringify({ type: 'auth', ticket })); await once(ws, 'close')
  assert.equal(f.messages.get(ws).at(-1).code, 'voice_model_unavailable')
  assert.equal(attempts, 1); assert.equal(f.providers.length, 0)
  enabled = true
  assert.equal(registry.resolve(DEFAULT_VOICE_MODEL).key, 'fixture-key')
  const retry = await f.open(); retry.send(JSON.stringify({ type: 'auth', ticket: f.ticket() })); await once(retry, 'close')
  assert.equal(attempts, 2)
  assert.equal(f.messages.get(retry).at(-1).code, 'provider_unavailable')
  assert.doesNotMatch(JSON.stringify([...f.messages.values()]), /fixture-key|fixture-unavailable/)
})

test('invalid voice model requests never connect upstream', async t => {
  const f = await fixture(t)
  for (const modelKey of [null, {}, [], '', 'unsupported/model']) {
    const response = await fetch(f.base + '/api/voice/ticket', { method: 'POST',
      headers: { Authorization: 'Bearer secret', Origin: 'https://chat.test' }, body: JSON.stringify({ conversationId: 'chat', modelKey }) })
    assert.equal(response.status, 400)
  }
  assert.equal(f.providers.length, 0)
})

test('call diagnostics retain timings and termination code without audio or context', async t => {
  const entries = [], f = await fixture(t, { onDiagnostic: e => entries.push(e) }), ws = await f.auth(), p = f.providers[0]
  event(p, { type: 'session.updated' }); await until(() => f.messages.get(ws).some(e => e.type === 'ready'))
  event(p, { type: 'error', error: { message: 'sensitive upstream response' } }); await once(ws, 'close')
  assert.deepEqual(entries.map(e => e.event), ['provider_connected', 'ready', 'ended'])
  assert.equal(entries.at(-1).code, 'provider_request_failed')
  assert.equal(entries.at(-1).stage, 'ready')
  assert.ok(entries.every(e => Number.isFinite(e.elapsedMs) && e.elapsedMs >= 0))
  assert.doesNotMatch(JSON.stringify(entries), /sensitive|hello|secret/)
})

test('diagnostic sink failures cannot interrupt a healthy call', async t => {
  const f = await fixture(t, { onDiagnostic: () => { throw Error('log unavailable') } }), ws = await f.auth(), p = f.providers[0]
  event(p, { type: 'session.updated' }); await until(() => f.messages.get(ws).some(e => e.type === 'ready'))
  ws.send(JSON.stringify({ type: 'audio', data: 'AAA=' })); await until(() => p.sent.some(e => e.type === 'input_audio_buffer.append'))
  assert.equal(p.dead, false)
})

test('main call accepts a bound manual proposal only after page confirmation', async t => {
  const submitted = []
  const runtime = { submit: async input => { submitted.push(input); return {id:'g',tasks:[{id:'t',title:'报告',status:'queued'}]} } }
  const f = await fixture(t, { runtime, canAccess: id => id === 'chat' }), ws = await f.auth(), p = f.providers[0]
  event(p, {type:'session.updated'}); await until(() => f.messages.get(ws).some(e => e.type === 'ready'))
  assert.ok(p.sent[0].session.tools.some(t => t.function.name === 'propose_tasks'))
  ws.send(JSON.stringify({type:'task.propose',requestId:'one',text:'制作报告'}))
  await until(() => f.messages.get(ws).some(e => e.type === 'task.proposal'))
  assert.equal(submitted.length,0)
  const proposal = f.messages.get(ws).find(e => e.type === 'task.proposal')
  ws.send(JSON.stringify({type:'task.confirm',id:proposal.id,approved:true}))
  ws.send(JSON.stringify({type:'task.confirm',id:proposal.id,approved:true}))
  await until(() => f.messages.get(ws).some(e => e.type === 'task.receipt'))
  ws.send(JSON.stringify({type:'hangup'})); await once(ws,'close')
  assert.equal(submitted.length,1); assert.equal(submitted[0].conversationId,'chat')
})

test('provider tool replies wait for active response and do not request overlapping responses', () => {
  const sent=[],calls=[]
  const protocol=createProviderEvents({send:e=>sent.push(e),emit:()=>{},context:[],onReady:()=>{},end:code=>assert.fail(code),onToolCall:e=>calls.push(e)})
  protocol.receive({type:'response.created',response:{id:'r1'}})
  protocol.receive({type:'response.function_call_arguments.done',call_id:'c1',name:'list_tasks',arguments:'{}'})
  assert.equal(calls.length,1)
  assert.equal(typeof protocol.toolResult,'function')
  protocol.toolResult('c1',{tasks:[]}); assert.equal(sent.filter(e=>e.type==='response.create').length,0)
  protocol.receive({type:'response.done',response:{id:'r1'}})
  assert.equal(sent.filter(e=>e.type==='response.create').length,1)
  protocol.toolResult('c2',{status:'accepted'})
  assert.equal(sent.filter(e=>e.type==='response.create').length,1)
  protocol.receive({type:'response.created',response:{id:'r2'}})
  protocol.receive({type:'response.done',response:{id:'r2'}})
  assert.equal(sent.filter(e=>e.type==='response.create').length,2)
})

test('ticket HTTP endpoint rejects query auth, foreign origin and unknown request fields', async t => {
  const f = await fixture(t)
  const post = (headers, body = { conversationId: 'chat' }) => fetch(f.base + '/api/voice/ticket?token=secret', { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal((await post({ Origin: 'https://chat.test' })).status, 401)
  assert.equal((await post({ Authorization: 'Bearer secret', Origin: 'https://evil.test' })).status, 403)
  assert.equal((await post({ Authorization: 'Bearer secret', Origin: 'https://chat.test' }, { conversationId: 'chat', context: 'inject' })).status, 400)
  const r = await post({ Authorization: 'Bearer secret', Origin: 'https://chat.test' }); assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(f.providers.length, 0)
})
test('missing or spoofed Origin cannot connect even with valid host', async t => {
  const f = await fixture(t)
  await assert.rejects(f.open('https://evil.test'), /403/); await assert.rejects(f.open(null), /403/)
  assert.equal(f.providers.length, 0)
})
test('invalid upgrade headers cannot consume the pending connection quota', async t => {
  const f = await fixture(t, { maxPending: 1 })
  await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/ws/chat-voice', { headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'https://chat.test', 'Sec-WebSocket-Key': 'bad', 'Sec-WebSocket-Version': '13' } }, res => { res.resume(); res.on('end', resolve) })
    req.on('error', reject); req.end()
  })
  const ws = await f.open(); ws.close()
})
test('authentication happens before provider; replay and concurrent calls are rejected', async t => {
  const f = await fixture(t), ws = await f.open(), ticket = f.ticket()
  assert.equal(f.providers.length, 0); ws.send(JSON.stringify({ type: 'auth', ticket }))
  await until(() => f.providers.length === 1)
  const replay = await f.open(); const closed = once(replay, 'close'); replay.send(JSON.stringify({ type: 'auth', ticket })); await closed
  assert.equal(f.providers.length, 1)
  assert.deepEqual(f.providers[0].sent[0].session.tools, [])
  const done = once(ws, 'close'); ws.close(); await done; await until(() => f.providers[0].dead)
})
test('context is injected server-side, mute clears, interruption clamps and blocks stale audio', async t => {
  const f = await fixture(t), ws = await f.auth(), p = f.providers[0]
  event(p, { type: 'session.updated' }); await until(() => f.messages.get(ws).some(e => e.type === 'ready'))
  assert.equal(p.sent.find(e => e.type === 'conversation.item.create').item.content[0].text, 'hello')
  event(p, { type: 'session.updated' })
  assert.equal(p.sent.filter(e => e.type === 'conversation.item.create').length, 1)
  event(p, { type: 'response.created', response: { id: 'r' } })
  event(p, { type: 'response.audio.delta', response_id: 'r', item_id: 'i', delta: Buffer.alloc(4800).toString('base64') })
  ws.send(JSON.stringify({ type: 'interrupt', responseId: 'r', itemId: 'i', playedMs: 99999 }))
  await until(() => p.sent.some(e => e.type === 'conversation.item.truncate'))
  assert.equal(p.sent.find(e => e.type === 'conversation.item.truncate').audio_end_ms, 100)
  event(p, { type: 'response.audio.delta', response_id: 'r', item_id: 'i', delta: 'AAAA' })
  ws.send(JSON.stringify({ type: 'mute' })); await until(() => p.sent.some(e => e.type === 'input_audio_buffer.clear'))
  ws.send(JSON.stringify({ type: 'hangup' })); await once(ws, 'close')
  assert.equal(p.dead, true); assert.equal(f.messages.get(ws).filter(e => e.type === 'audio').length, 1)
})
test('deleted session never opens provider, pending count and auth timeout are bounded', async t => {
  const f = await fixture(t, { maxPending: 1, authTimeoutMs: 60 })
  const ticket = f.ticket(); f.remove(); const ws = await f.open()
  await assert.rejects(f.open(), /429/)
  ws.send(JSON.stringify({ type: 'auth', ticket })); await once(ws, 'close'); assert.equal(f.providers.length, 0)
  const unauth = await f.open(); await once(unauth, 'close'); assert.equal(f.providers.length, 0)
})
test('provider setup timeout and maximum call duration release upstream', async t => {
  for (const options of [{ setupTimeoutMs: 20 }, { maxCallMs: 20 }]) {
    const f = await fixture(t, options), ws = await f.auth(); await once(ws, 'close'); assert.equal(f.providers[0].dead, true)
  }
})
test('unknown events, binary, huge payloads and rapid frames fail closed without leaking upstream', async t => {
  for (const attack of ['tool', 'binary', 'huge', 'rate']) {
    const f = await fixture(t), ws = await f.auth(), p = f.providers[0]
    event(p, { type: 'session.updated' }); await until(() => f.messages.get(ws).some(e => e.type === 'ready'))
    const closed = once(ws, 'close')
    if (attack === 'binary') ws.send(Buffer.from('x'))
    else if (attack === 'huge') ws.send('x'.repeat(70000))
    else if (attack === 'rate') for (let i = 0; i < 90; i++) ws.send(JSON.stringify({ type: 'mute' }))
    else ws.send(JSON.stringify({ type: 'task.confirm', key: 'sensitive' }))
    await closed; await until(() => p.dead)
    assert.ok(!JSON.stringify(f.messages.get(ws)).includes('sensitive'))
  }
})
