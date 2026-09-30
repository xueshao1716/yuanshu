import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceAdmission } from '../../engine/chat-voice-admission.mjs'
import { selectVoiceContext, createVoiceSessionReader } from '../../engine/chat-voice-context.mjs'

test('ticket binds the validated model and rejects arbitrary upstream selections', () => {
  const a = createVoiceAdmission({ getToken: () => 'secret', readSession: () => [] })
  const req = { headers: { authorization: 'Bearer secret' } }
  const modelKey = 'stepfun-plan/stepaudio-2.5-realtime'
  assert.equal(a.consume(a.issue(req, 'chat', modelKey).ticket).modelKey, modelKey)
  assert.throws(() => a.issue(req, 'chat', 'https://evil.test/tts'), /voice_model_unsupported/)
})

test('configured availability is validated before issuing a ticket', () => {
  const a = createVoiceAdmission({ getToken: () => 'secret', readSession: () => [],
    resolveModel: () => { throw new Error('voice_model_unavailable') } })
  assert.throws(() => a.issue({ headers: { authorization: 'Bearer secret' } }, 'chat'), /voice_model_unavailable/)
})

test('tickets require header authentication and known conversation; never accept query token', () => {
  const a = createVoiceAdmission({ getToken: () => 'secret', readSession: id => id === 'chat' ? [] : null })
  assert.throws(() => a.issue({ headers: {}, url: '/?token=secret' }, 'chat'), /unauthorized/)
  assert.throws(() => a.issue({ headers: { authorization: 'Bearer secret' } }, '../file'), /conversation_gone/)
  const t = a.issue({ headers: { authorization: 'Bearer secret' } }, 'chat')
  const claim = a.consume(t.ticket)
  assert.equal(claim.conversationId, 'chat'); assert.notEqual(claim.login, 'secret')
  assert.equal(a.consume(t.ticket), null)
})
test('tickets expire, bind current login and recheck deleted sessions', () => {
  let now = 0, token = 'key', exists = true
  const a = createVoiceAdmission({ getToken: () => token, readSession: () => exists ? [] : null, now: () => now })
  const issue = () => a.issue({ headers: { authorization: `Bearer ${token}` } }, 'chat').ticket
  const expired = issue(); now = 60000; assert.equal(a.consume(expired), null)
  const rotated = issue(); token = 'new'; assert.equal(a.consume(rotated), null)
  const deleted = issue(); exists = false; assert.equal(a.consume(deleted), null)
})
test('issuance is bounded and one active call per login is leased and released', () => {
  const a = createVoiceAdmission({ getToken: () => 'k', readSession: () => [], maxTickets: 2, maxIssues: 3 })
  const issue = () => a.issue({ headers: { authorization: 'Bearer k' } }, 'chat').ticket
  const first = issue(), second = issue(); assert.throws(issue, /rate_limit/)
  const claim = a.consume(first); assert.equal(a.acquire(claim), true); assert.equal(a.acquire(claim), false)
  assert.throws(issue, /call_busy/); a.release(claim); assert.equal(a.acquire(a.consume(second)), true)
})
test('context only selects recent text user/assistant messages within both limits', () => {
  const input = [{ role: 'system', text: 'secret' }, ...Array.from({ length: 20 }, (_, n) => ({ role: n % 2 ? 'user' : 'assistant', text: String(n).padEnd(1000, 'x'), tools: ['secret'] })), { role: 'tool', text: 'private' }]
  const c = selectVoiceContext(input)
  assert.ok(c.length <= 12); assert.equal(c.reduce((n, m) => n + m.content.length, 0), 8000)
  assert.ok(c.every(m => Object.keys(m).join(',') === 'role,content'))
  assert.equal(c.at(-1).content.slice(0, 2), '19')
  assert.deepEqual(selectVoiceContext([{ role: 'user', content: [{ type: 'image', data: 'secret' }] }]), [])
})
test('reader accepts lazy active sessions and resolves current branch without caller paths', () => {
  const entries = [{ id: 'a' }]
  const read = createVoiceSessionReader({ activeSessions: new Map([['new', { sm: { fileEntries: entries, getLeafId: () => 'leaf' } }]]),
    findSession: () => null, readEntriesFromFile: () => { throw new Error('disk should not run') }, resolveLeafId: () => '',
    extractMessages: (e, leaf) => { assert.equal(e, entries); assert.equal(leaf, 'leaf'); return [{ role: 'user', text: 'hello' }] } })
  assert.deepEqual(read('new'), [{ role: 'user', content: 'hello' }]); assert.equal(read('../secret'), null)
})
