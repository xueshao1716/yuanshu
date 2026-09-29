import { createPcmPacketizer } from '../lib/realtime-pcm.mjs'

class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.enabled = false; this.epoch = 0
    this.packetizer = createPcmPacketizer(sampleRate, bytes => this.port.postMessage({ bytes, epoch: this.epoch }, [bytes.buffer]))
    this.port.onmessage = ({ data }) => { this.enabled = data.enabled === true; this.epoch = data.epoch; this.packetizer.reset() }
  }
  process(inputs) { if (this.enabled && inputs[0]?.[0]) this.packetizer.push(inputs[0][0]); return true }
}
registerProcessor('yuanshu-voice-capture', VoiceCapture)
