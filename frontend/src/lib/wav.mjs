// 录音转 16k 单声道 WAV Base64（2026-11-23 从 SendBox 抽出，助理卡片也用它）
// 服务端 /api/asr 走阶跃语音识别，统一送 16k/mono/16bit 的 WAV 最稳。
export async function blobToWavBase64(blob) {
  const buf = await blob.arrayBuffer()
  const AC = window.AudioContext || window.webkitAudioContext
  const ctx = new AC()
  let audio
  try { audio = await ctx.decodeAudioData(buf) } finally { ctx.close().catch(() => {}) }
  const TARGET_RATE = 16000
  const chCount = Math.min(audio.numberOfChannels, 2)
  const ratio = audio.sampleRate / TARGET_RATE
  const outLen = Math.floor(audio.length / ratio)
  const out = new Float32Array(outLen)
  const chans = []
  for (let c = 0; c < chCount; c++) chans.push(audio.getChannelData(c))
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio
    const i0 = Math.floor(srcIdx), frac = srcIdx - i0
    const i1 = Math.min(i0 + 1, audio.length - 1)
    let sum = 0
    for (let c = 0; c < chCount; c++) sum += chans[c][i0] * (1 - frac) + chans[c][i1] * frac
    out[i] = sum / chCount
  }
  const dataLen = out.length * 2
  const view = new DataView(new ArrayBuffer(44 + dataLen))
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  ws(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE')
  ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_RATE, true); view.setUint32(28, TARGET_RATE * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ws(36, 'data'); view.setUint32(40, dataLen, true)
  for (let i = 0; i < out.length; i++) {
    const s = Math.max(-1, Math.min(1, out[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  let bin = ''; const bytes = new Uint8Array(view.buffer)
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
