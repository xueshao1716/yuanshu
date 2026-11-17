// 通话声波的音量来源：AnalyserNode 的频谱 → 低/中/高三段 + 总音量（都在 0..1）。
// 只读真实音频；没声音就是 0，不做任何伪造起伏。
export const ZERO_BANDS = Object.freeze({ level: 0, low: 0, mid: 0, high: 0 })

// 频谱按 fftSize 256（128 个频点）划段：48k 采样时每点约 190Hz。
// 低 ≈ 190–940Hz（人声基频/元音），中 ≈ 0.9–3kHz，高 ≈ 3–7.5kHz（齿音）。
const RANGES = { low: [1, 5], mid: [5, 17], high: [17, 41] }
const curve = v => Math.min(1, Math.max(0, (v - 0.15) / 0.6))

export function readBands(bytes) {
  const out = {}
  for (const [key, [from, to]] of Object.entries(RANGES)) {
    let sum = 0
    for (let i = from; i < to && i < bytes.length; i++) sum += bytes[i]
    out[key] = curve(sum / Math.max(1, Math.min(to, bytes.length) - from) / 255)
  }
  const level = Math.min(1, out.low * 0.5 + out.mid * 0.35 + out.high * 0.15)
  return level ? { level, ...out } : ZERO_BANDS
}

// 起得快、落得慢：说话一出声波就跟上，停顿时缓缓收回，不会一闪一闪。
export function smoothBands(prev, next) {
  const out = {}
  for (const k of ['level', 'low', 'mid', 'high']) {
    const a = prev[k] || 0, b = next[k] || 0
    out[k] = a + (b - a) * (b > a ? 0.5 : 0.12)
  }
  return out
}

export function createMeter(context) {
  const analyser = context.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.6
  const bytes = new Uint8Array(analyser.frequencyBinCount || 128)
  return { node: analyser, read() { analyser.getByteFrequencyData(bytes); return readBands(bytes) } }
}
