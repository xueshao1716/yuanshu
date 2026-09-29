import { pcm16ToFloat } from './realtime-pcm.mjs';

// A playback-only AudioContext: never requests microphone permission.
export function createSpeechPcmPlayer({ AudioContext = globalThis.AudioContext, onState = () => {} } = {}) {
  let context, nextAt = 0, paused = false;
  const sources = new Set();
  function ensure() {
    if (!context) {
      context = new AudioContext({ latencyHint: 'interactive' });
      context.onstatechange = () => {
        paused = context.state !== 'running';
        onState(paused ? 'paused' : sources.size ? 'speaking' : 'empty');
      };
    }
    return context;
  }
  function stop() {
    for (const source of sources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    sources.clear(); nextAt = 0; paused = false;
  }
  const pendingSeconds = () => context && sources.size ? Math.max(0, nextAt - context.currentTime) : 0;
  return {
    supported: Boolean(AudioContext), stop, pendingSeconds,
    get paused() { return paused; },
    unlock() { const ctx = ensure(); const result = ctx.resume(); paused = ctx.state !== 'running'; return result; },
    push(data) {
      if (typeof data !== 'string' || data.length > 1400000) throw new Error('语音数据异常。');
      const samples = pcm16ToFloat(Uint8Array.from(atob(data), c => c.charCodeAt(0)));
      if (!samples.length) return;
      const ctx = ensure(), at = Math.max(ctx.currentTime + 0.03, nextAt);
      if (at + samples.length / 24000 - ctx.currentTime > 90 || sources.size >= 2000) throw new Error('待播放语音过多，请稍后点击朗读。');
      const buffer = ctx.createBuffer(1, samples.length, 24000); buffer.copyToChannel(samples, 0);
      const source = ctx.createBufferSource(); source.buffer = buffer; source.connect(ctx.destination);
      sources.add(source); nextAt = at + buffer.duration;
      source.onended = () => { sources.delete(source); source.disconnect(); if (!sources.size) onState('empty'); };
      source.start(at); paused = ctx.state !== 'running'; onState(paused ? 'paused' : 'speaking');
    },
    async pause() { paused = true; if (context) await context.suspend(); onState('paused'); },
    async resume() { await ensure().resume(); paused = context.state !== 'running'; onState(paused ? 'paused' : sources.size ? 'speaking' : 'empty'); },
  };
}
