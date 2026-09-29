import WebSocket from 'ws';
import { speechVoice } from './speech-voice.mjs';

export function connectTtsStream(config) {
  const url = new URL(config.endpoint.replace(/\/audio\/speech$/, '/realtime/audio'));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('model', config.model);
  return new WebSocket(url, { headers: { Authorization: `Bearer ${config.key}` },
    handshakeTimeout: 12000, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
}

// Auth stays on the ordinary HTTP route. Neither browser nor logs see the provider key.
export function streamReplyTts({ config, text, res, connect = connectTtsStream, timeoutMs = 65000 }) {
  return new Promise((resolve, reject) => {
    let ws, ended = false, sessionId = '', started = false, received = 0;
    const timer = setTimeout(() => finish(new Error('阶跃流式朗读超时，请重试。')), timeoutMs);
    timer.unref?.();
    function finish(error) {
      if (ended) return;
      ended = true; clearTimeout(timer); res.off('close', disconnected); ws?.terminate();
      if (error) reject(error); else resolve();
    }
    function disconnected() { finish(); }
    function emit(event) {
      if (ended || res.destroyed) return;
      if (res.writableLength > 1024 * 1024) throw new Error('播放连接过慢，请重试。');
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.write(JSON.stringify(event) + '\n');
    }
    function send(type, data = {}) { ws.send(JSON.stringify({ type, data: { session_id: sessionId, ...data } })); }
    res.once('close', disconnected);
    if (res.destroyed) { finish(); return; }
    try {
      ws = connect(config);
      ws.on('error', () => finish(new Error('阶跃流式语音连接失败，请重试。')));
      ws.on('close', () => { if (!ended) finish(new Error('语音连接提前结束，请点击朗读重试。')); });
      ws.on('message', (raw, binary) => {
        if (ended) return;
        try {
          if (binary || raw.length > 8 * 1024 * 1024) throw new Error('语音数据格式异常。');
          const event = JSON.parse(raw), data = event.data || {};
          if (event.type === 'tts.connection.done' && !sessionId) {
            if (typeof data.session_id !== 'string' || !data.session_id) throw new Error('语音会话未就绪。');
            sessionId = data.session_id;
            send('tts.create', { voice_id: speechVoice.id, response_format: 'pcm', sample_rate: 24000,
              mode: 'default', text_normalization: 'standard', speed_ratio: 1 });
          } else if (event.type === 'tts.response.created' && sessionId && !started) {
            started = true; send('tts.text.delta', { text }); send('tts.text.done');
          } else if (event.type === 'tts.response.audio.delta') {
            if (!started || typeof data.audio !== 'string') throw new Error('语音数据格式异常。');
            if (!data.audio) return;
            if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data.audio) || data.audio.length % 4 || data.audio.length > 1400000) throw new Error('语音数据格式异常。');
            const bytes = Buffer.from(data.audio, 'base64');
            if (bytes.length % 2 || (received += bytes.length) > 4 * 1024 * 1024) throw new Error('语音数据超出限制。');
            emit({ type: 'audio', data: data.audio, sampleRate: 24000 });
          } else if (event.type === 'tts.response.audio.done') {
            if (!received) throw new Error('未收到有效语音，请重试。');
            // audio.done includes ALL audio again. It is completion, not a playable delta.
            emit({ type: 'done' }); res.end(); finish();
          } else if (event.type === 'tts.response.error') throw new Error('阶跃流式合成失败，请检查额度或稍后重试。');
        } catch (error) { finish(error); }
      });
    } catch { finish(new Error('阶跃流式语音连接失败，请重试。')); }
  });
}
