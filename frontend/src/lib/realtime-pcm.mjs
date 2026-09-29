// Step's official console uses 24kHz mono PCM16 in both directions.
// Area-average downsampling retains fractional phase across audio-worklet blocks.
export function createPcmResampler(inputRate, outputRate = 24000) {
  if (!Number.isFinite(inputRate) || inputRate < outputRate || inputRate > 192000) throw new Error('unsupported_sample_rate')
  const ratio = inputRate / outputRate
  let weight = 0, total = 0
  return {
    reset() { weight = 0; total = 0 },
    push(samples) {
      const result = []
      for (const sample of samples) {
        let remaining = 1
        while (remaining > 1e-8) {
          const take = Math.min(remaining, ratio - weight)
          total += (Number.isFinite(sample) ? sample : 0) * take; weight += take; remaining -= take
          if (weight >= ratio - 1e-8) {
            const value = Math.max(-1, Math.min(1, total / ratio))
            const pcm = Math.round(value * (value < 0 ? 32768 : 32767))
            result.push(pcm & 255, (pcm >> 8) & 255); weight = 0; total = 0
          }
        }
      }
      return new Uint8Array(result)
    },
  }
}
export function pcm16ToFloat(bytes) {
  if (bytes.byteLength % 2) throw new Error('invalid_pcm')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Float32Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768)
}

export function createPcmPacketizer(inputRate, emit) {
  const sampler = createPcmResampler(inputRate)
  let packet = new Uint8Array(1920), offset = 0
  return {
    reset() { sampler.reset(); packet = new Uint8Array(1920); offset = 0 },
    push(samples) {
      const bytes = sampler.push(samples)
      for (let at = 0; at < bytes.length;) {
        const size = Math.min(packet.length - offset, bytes.length - at)
        packet.set(bytes.subarray(at, at + size), offset); at += size; offset += size
        if (offset === packet.length) { emit(packet); packet = new Uint8Array(1920); offset = 0 }
      }
    },
  }
}
