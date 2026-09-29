import test from 'node:test'
import assert from 'node:assert/strict'
import { createPcmPacketizer } from '../../frontend/src/lib/realtime-pcm.mjs'
import { createPlayback } from '../../frontend/src/realtime/playback.mjs'

test('capture batches 40ms packets and reset drops unsent microphone samples', () => {
  const packets = [], packetizer = createPcmPacketizer(48000, p => packets.push(p))
  for (let i = 0; i < 15; i++) packetizer.push(new Float32Array(128).fill(0.5))
  assert.equal(packets.length, 1); assert.equal(packets[0].byteLength, 1920)
  packetizer.push(new Float32Array(1000)); packetizer.reset()
  packetizer.push(new Float32Array(1000)); assert.equal(packets.length, 1)
})

function context() {
  const sources = []
  return { currentTime: 10, baseLatency: 0, outputLatency: 0, destination: {}, sources,
    createBuffer: (_, length, rate) => ({ duration: length / rate, copyToChannel() {} }),
    createBufferSource() { const s = { connect() {}, disconnect() {}, start(at) { this.at = at }, stop() { this.stopped = true } }; sources.push(s); return s },
    getOutputTimestamp() { return { contextTime: this.currentTime } },
  }
}
const event = (r = 'r1', i = 'i1', seconds = 1) => ({ responseId: r, itemId: i, data: Buffer.alloc(48000 * seconds).toString('base64') })
test('playback reports heard item time, clears queue, and ignores late interrupted audio', () => {
  const ctx = context(), playback = createPlayback(ctx)
  playback.push(event()); playback.push(event())
  ctx.currentTime = 10.53
  const cursor = playback.interrupt()
  assert.equal(cursor.responseId, 'r1'); assert.equal(cursor.itemId, 'i1'); assert.ok(Math.abs(cursor.playedMs - 500) < 1)
  assert.ok(ctx.sources.every(s => s.stopped)); assert.equal(playback.push(event()), false)
  assert.equal(playback.push(event('r2', 'i2')), true)
  playback.close(); assert.ok(ctx.sources.every(s => s.stopped))
})
test('playback bounds ahead-of-speaker queue and uses actual speaker clock', () => {
  const ctx = context(), playback = createPlayback(ctx)
  playback.push(event('r1', 'i1', 20)); assert.throws(() => playback.push(event('r1', 'i1', 20)), /playback_queue_limit/)
  ctx.currentTime = 12; ctx.getOutputTimestamp = () => ({ contextTime: 11 })
  assert.ok(Math.abs(playback.interrupt().playedMs - 970) < 1)
  playback.close()
})

test('playing notifications follow the full queue and ignore late ended events after interruption', () => {
  const ctx = context(), states = [], playback = createPlayback(ctx, value => states.push(value))
  playback.push(event()); playback.push(event())
  assert.deepEqual(states, [true])
  ctx.sources[0].onended(); assert.deepEqual(states, [true])
  ctx.sources[1].onended(); assert.deepEqual(states, [true, false])
  playback.push(event('r2', 'i2')); const late = ctx.sources[2].onended
  playback.interrupt(); playback.push(event('r3', 'i3')); late()
  assert.deepEqual(states, [true, false, true, false, true])
  playback.close(); assert.deepEqual(states, [true, false, true, false, true, false])
})
