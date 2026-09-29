import test from 'node:test'
import assert from 'node:assert/strict'
import { createProviderEvents } from '../../engine/chat-voice-provider.mjs'

function fixture() {
  const sent = [], emitted = [], ended = [], recovered = []
  const protocol = createProviderEvents({ send: e => sent.push(e), emit: e => emitted.push(e), context: [],
    onReady() {}, end: e => ended.push(e), onRecoverableError: code => recovered.push(code) })
  return { protocol, sent, emitted, ended, recovered }
}
const emptyCancel = eventId => ({ type: 'error', error: { type: 'invalid_request_error',
  event_id: eventId, message: 'no ongoing response to cancel' } })

test('repeated interruptions cancel each response once with a correlated event id', () => {
  const f = fixture()
  f.protocol.receive({ type: 'response.created', response: { id: 'r1' } })
  f.protocol.interrupt({}); f.protocol.interrupt({})
  const cancels = f.sent.filter(e => e.type === 'response.cancel')
  assert.equal(cancels.length, 1)
  assert.equal(typeof cancels[0].event_id, 'string')
  f.protocol.receive({ type: 'response.done', response: { id: 'r1' } })
  f.protocol.receive({ type: 'response.created', response: { id: 'r2' } })
  f.protocol.interrupt({})
  assert.notEqual(f.sent.at(-1).event_id, cancels[0].event_id)
})

test('verified late cancel error keeps the call usable, including after response.done', () => {
  const f = fixture()
  f.protocol.receive({ type: 'response.created', response: { id: 'r1' } })
  f.protocol.receive({ type: 'input_audio_buffer.speech_started' })
  f.protocol.interrupt({})
  const cancel = f.sent.find(e => e.type === 'response.cancel')
  f.protocol.receive({ type: 'response.done', response: { id: 'r1' } })
  f.protocol.receive(emptyCancel(cancel.event_id))
  assert.deepEqual(f.ended, [])
  assert.deepEqual(f.recovered, ['cancel_already_finished'])
  f.protocol.receive({ type: 'response.created', response: { id: 'r2' } })
  f.protocol.receive({ type: 'response.audio.delta', response_id: 'r2', item_id: 'i2', delta: 'AAAA' })
  assert.equal(f.emitted.at(-1).type, 'audio')
})

test('uncorrelated cancellation and other provider errors still fail closed', () => {
  for (const mode of ['unknown-id', 'other-error', 'other-type']) {
    const f = fixture()
    f.protocol.receive({ type: 'response.created', response: { id: 'r' } }); f.protocol.interrupt({})
    const e = emptyCancel(f.sent[0].event_id)
    if (mode === 'unknown-id') e.error.event_id = 'not-ours'
    if (mode === 'other-error') e.error.message = 'unsupported audio format'
    if (mode === 'other-type') e.error.type = 'server_error'
    f.protocol.receive(e)
    assert.deepEqual(f.ended, ['provider_request_failed'])
  }
})
