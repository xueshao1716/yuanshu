import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readBands, smoothBands, ZERO_BANDS } from '../../frontend/src/realtime/levels.mjs'
import { createPlayback } from '../../frontend/src/realtime/playback.mjs'
import { createVoiceAudio } from '../../frontend/src/realtime/audio.mjs'

const src = p => fs.readFileSync(new URL(`../../frontend/src/${p}`, import.meta.url), 'utf8')

test('readBands: 静音为零，有声时各频段落在 0..1', () => {
  assert.deepEqual(readBands(new Uint8Array(128)), ZERO_BANDS)
  const loud = new Uint8Array(128).fill(200)
  const b = readBands(loud)
  for (const k of ['level', 'low', 'mid', 'high']) assert.ok(b[k] > 0.3 && b[k] <= 1, `${k}=${b[k]}`)
  const lowOnly = new Uint8Array(128); lowOnly.fill(220, 1, 5)
  const l = readBands(lowOnly)
  assert.ok(l.low > l.high, '低频声音只抬低频')
})

test('smoothBands: 起得快、落得慢', () => {
  const up = smoothBands(ZERO_BANDS, { level: 1, low: 1, mid: 1, high: 1 })
  const down = smoothBands({ level: 1, low: 1, mid: 1, high: 1 }, ZERO_BANDS)
  assert.ok(up.level > 0.4, '起势')
  assert.ok(down.level > 0.6, '落势更慢')
})

test('playback 可以接到指定输出节点（给回放音量计用）', () => {
  const output = { id: 'meter' }, sources = []
  const ctx = { currentTime: 10, baseLatency: 0, outputLatency: 0, destination: {},
    createBuffer: () => ({ copyToChannel() {} }),
    createBufferSource() { const s = { connect(n) { this.to = n }, disconnect() {}, start() {}, stop() {} }; sources.push(s); return s } }
  createPlayback(ctx, () => {}, output).push({ responseId: 'r', itemId: 'i', data: btoa('\x00\x10\x00\x10') })
  assert.equal(sources[0].to, output)
})

test('通话音频暴露 levels()：麦克风和回放各一只分析器', async () => {
  const analysers = []
  class Ctx {
    constructor() { this.state = 'running'; this.destination = { id: 'dest' }; this.audioWorklet = { addModule: async () => {} } }
    resume() { return Promise.resolve() } close() { return Promise.resolve() }
    createGain() { return { gain: {}, connect() {}, disconnect() {} } }
    createMediaStreamSource() { return { connect(n) { (this.to ||= []).push(n) }, disconnect() {} } }
    createAnalyser() { const a = { fftSize: 0, frequencyBinCount: 128, connect(n) { this.to = n }, disconnect() {}, getByteFrequencyData(arr) { arr.fill(180) } }; analysers.push(a); return a }
  }
  class Node { constructor() { this.port = { postMessage() {} } } connect() {} disconnect() {} }
  const track = { stop() {} }
  const env = { isSecureContext: true, AudioContext: Ctx, AudioWorkletNode: Node,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } } }
  const audio = await createVoiceAudio({ onPacket() {}, workletUrl: 'x' }, env)
  assert.equal(analysers.length, 2)
  assert.equal(analysers[1].to.id, 'dest', '回放分析器串到扬声器')
  assert.equal(audio.levels().mic.level, 0, '未就绪（静音）时麦克风不出波')
  audio.setMuted(false)
  const lv = audio.levels()
  assert.ok(lv.mic.level > 0 && lv.out.level > 0)
  audio.close()
})

test('通话控制器透出 levels，通话画面用 WebGL 声波并保留降级', () => {
  assert.match(src('realtime/call.mjs'), /levels\(\)\s*\{\s*return audio\?\.levels\?\.\(\) \|\| null/)
  const stage = src('components/voice/CallStage.tsx')
  assert.match(stage, /<canvas/)
  assert.match(stage, /prefers-reduced-motion/)
  assert.match(stage, /voice-orb-flow/, '没有 WebGL 时退回原来的光球')
  assert.match(src('components/voice/RealtimeCall.tsx'), /levels=\{/)
  assert.match(src('realtime/siri-wave.mjs'), /MIT/)
})
