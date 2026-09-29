import test from 'node:test'
import assert from 'node:assert/strict'
import { createPcmResampler, pcm16ToFloat } from '../../frontend/src/lib/realtime-pcm.mjs'

test('resampling 48k and 44.1k is chunk invariant at 24k', () => {
  for (const rate of [48000, 44100, 24000]) {
    const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(i / 100) * 0.5)
    const whole = createPcmResampler(rate).push(input), stream = createPcmResampler(rate), chunks = []
    for (let i = 0; i < input.length; i += 128) chunks.push(...stream.push(input.subarray(i, i + 128)))
    assert.equal(whole.length, 48000); assert.deepEqual(chunks, [...whole])
  }
})
test('PCM clamps samples, decodes signed little endian and reset drops stale input', () => {
  const sampler = createPcmResampler(48000)
  sampler.push(new Float32Array([1])); sampler.reset()
  const pcm = sampler.push(new Float32Array([-2, -2, 2, 2]))
  assert.deepEqual([...pcm], [0, 128, 255, 127])
  assert.deepEqual([...pcm16ToFloat(pcm)], [-1, 32767 / 32768])
  assert.throws(() => createPcmResampler(8000))
})
