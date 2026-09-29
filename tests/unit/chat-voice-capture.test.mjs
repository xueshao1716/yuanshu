import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceAudio } from '../../frontend/src/realtime/audio.mjs'

function platform(getUserMedia) {
  const contexts = [], nodes = []
  class Context {
    constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; contexts.push(this) }
    async resume() {} async close() { this.state = 'closed' }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createGain() { return { gain: {}, connect() {}, disconnect() {} } }
  }
  class Node { constructor() { this.port = { postMessage() {} }; nodes.push(this) } connect() {} disconnect() {} }
  return { navigator: { mediaDevices: { getUserMedia } }, AudioContext: Context, AudioWorkletNode: Node, contexts, nodes }
}

test('microphone request is immediate even while playback resume is pending', async () => {
  let resume, requests = 0
  const stages = [], track = { enabled: true, stop() {} }
  const env = platform(async () => { requests++; return { getTracks: () => [track] } })
  env.AudioContext.prototype.resume = () => new Promise(resolve => { resume = resolve })
  const pending = createVoiceAudio({ onPacket() {}, onStage: stage => stages.push(stage) }, env)
  assert.equal(requests, 1, 'permission must start in the click stack, not after resume')
  await Promise.resolve()
  assert.equal(track.enabled, false, 'do not capture before the call is ready')
  assert.deepEqual(stages, ['audio'])
  resume(); const audio = await pending; audio.close()
})

test('resume failure releases late microphone grants without an unhandled rejection', async () => {
  let grant, stopped = 0
  const env = platform(() => new Promise(resolve => { grant = resolve }))
  env.AudioContext.prototype.resume = async () => { throw new Error('resume_failed') }
  const pending = createVoiceAudio({ onPacket() {} }, env)
  await assert.rejects(pending, /audio_initialization_failed/)
  assert.equal(typeof grant, 'function')
  grant({ getTracks: () => [{ stop() { stopped++ } }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, 1); assert.equal(env.contexts[0].state, 'closed')
})

test('worklet setup failures release the microphone and identify audio processing', async () => {
  const track = { stop() { this.stopped = true } }
  const env = platform(async () => ({ getTracks: () => [track] }))
  env.AudioContext.prototype.resume = async function () { this.audioWorklet.addModule = async () => { throw new Error('module failure') } }
  await assert.rejects(createVoiceAudio({ onPacket() {} }, env), /audio_processing_failed/)
  assert.equal(track.stopped, true); assert.equal(env.contexts[0].state, 'closed')
})

test('permission denial is reported without waiting for a suspended audio context', async () => {
  const env = platform(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }) })
  env.AudioContext.prototype.resume = () => new Promise(() => {})
  const result = await Promise.race([
    createVoiceAudio({ onPacket() {} }, env).then(() => 'unexpected', e => e.name),
    new Promise(resolve => setTimeout(() => resolve('still_waiting'), 50)),
  ])
  assert.equal(result, 'NotAllowedError'); assert.equal(env.contexts[0].state, 'closed')
})
test('cancelling while permission is pending releases context and late media tracks', async () => {
  let grant, stopped = false
  const env = platform(() => new Promise(resolve => { grant = resolve })), controller = new AbortController()
  const promise = createVoiceAudio({ onPacket() {}, signal: controller.signal }, env)
  await Promise.resolve(); controller.abort()
  grant({ getTracks: () => [{ stop() { stopped = true } }] })
  await assert.rejects(promise); assert.equal(stopped, true); assert.equal(env.contexts[0].state, 'closed')
})
test('capture ignores buffered frames on mute and stops tracks on close', async () => {
  const track = { enabled: true, stop() { this.stopped = true } }, packets = []
  const env = platform(async () => ({ getTracks: () => [track] }))
  const audio = await createVoiceAudio({ onPacket: bytes => packets.push(bytes), onFailure() {} }, env)
  audio.setMuted(false)
  env.nodes[0].port.onmessage({ data: { epoch: 1, bytes: new Uint8Array(1920) } }); assert.equal(packets.length, 1)
  audio.setMuted(true)
  env.nodes[0].port.onmessage({ data: { epoch: 1, bytes: new Uint8Array(1920) } }); assert.equal(packets.length, 1); assert.equal(track.enabled, false)
  audio.setMuted(false)
  env.nodes[0].port.onmessage({ data: { epoch: 1, bytes: new Uint8Array(1920) } }); assert.equal(packets.length, 1)
  audio.close(); assert.equal(track.stopped, true); assert.equal(env.contexts[0].state, 'closed')
})
test('secure context, bundled module URL and interrupted audio fail explicitly', async () => {
  const env = platform(async () => ({ getTracks: () => [] })); env.isSecureContext = false
  await assert.rejects(createVoiceAudio({ onPacket() {} }, env), /secure_context_required/)
  env.isSecureContext = true; const errors = []
  const audio = await createVoiceAudio({ onPacket() {}, workletUrl: '/assets/bundled.js', onFailure: e => errors.push(e) }, env)
  env.contexts[0].state = 'suspended'; env.contexts[0].onstatechange(); assert.deepEqual(errors, ['audio_interrupted']); audio.close()
})
