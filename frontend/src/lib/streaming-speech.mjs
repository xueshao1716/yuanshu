import { createSpeechPcmPlayer } from './speech-pcm-player.mjs';

export function createStreamingSpeech({ synthesize, createPlayer = createSpeechPcmPlayer }) {
  let token = 0, controller, queue = [], chars = 0, running = false, finished = false, recording = false;
  let snapshot = { id: '', status: 'idle', error: '' };
  const listeners = new Set();
  const update = patch => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); };
  const player = createPlayer({ onState: state => {
    if (!snapshot.id || snapshot.status === 'error') return;
    if (state === 'empty') settle();
    else update({ status: state, error: state === 'paused' ? '点击继续朗读以允许播放。' : '' });
  } });
  function stop() { token++; controller?.abort(); queue = []; chars = 0; running = false; finished = false; player.stop(); update({ id: '', status: 'idle', error: '' }); }
  function settle() {
    if (snapshot.status === 'error' || player.paused || player.pendingSeconds() > 0) return;
    if (finished && !queue.length && !running) stop();
    else update({ status: 'loading' });
  }
  async function waitForRoom(signal) {
    while (!signal.aborted && (player.paused || player.pendingSeconds() > 8)) {
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 100); signal.addEventListener('abort', done, { once: true });
      });
    }
  }
  async function pump() {
    if (running || !controller || controller.signal.aborted) return;
    running = true; const active = token, signal = controller.signal;
    try {
      while (queue.length && active === token) {
        await waitForRoom(signal); if (signal.aborted || active !== token) return;
        const text = queue.shift(); chars -= text.length;
        await synthesize(text, { signal, onAudio: event => {
          if (active === token && !signal.aborted) player.push(event.data);
        } });
      }
    } catch (error) {
      if (active !== token || signal.aborted) return;
      controller.abort(); queue = []; chars = 0; player.stop(); update({ status: 'error', error: error.message || '流式朗读失败，请重试。' });
    } finally { if (active === token) { running = false; settle(); } }
  }
  return {
    supported: player.supported,
    unlock: () => { try { void Promise.resolve(player.unlock()).catch(() => {}); } catch {} },
    begin(id) {
      stop();
      if (recording || !player.supported) { update({ id, status: 'error', error: recording ? '录音或通话中，朗读已停止。' : '当前设备不支持流式朗读。' }); return; }
      controller = new AbortController(); update({ id, status: 'loading', error: '' });
      const active = token;
      const blocked = () => { if (active === token) update({ status: 'paused', error: '点击继续朗读以允许播放。' }); };
      try { void Promise.resolve(player.unlock()).catch(blocked); if (player.paused) blocked(); } catch { blocked(); }
    },
    append(text) {
      if (!snapshot.id || snapshot.status === 'error' || finished) return;
      if (chars + text.length > 30000) { stop(); update({ status: 'error', error: '回复较长，已停止预读；可在回复完成后手动朗读。' }); return; }
      queue.push(text); chars += text.length; void pump();
    },
    finish() { finished = true; settle(); }, stop,
    pause: () => { if (snapshot.id) void player.pause().catch(() => {}); },
    resume: () => { if (snapshot.id) void player.resume().catch(() => update({ status: 'paused', error: '无法播放，请再点击继续。' })); },
    setRecording(value) { recording = value; if (value) stop(); },
    getSnapshot: () => snapshot,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
