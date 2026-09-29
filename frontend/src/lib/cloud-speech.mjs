import { speechText } from './speech-output.mjs';

export function cloudChunks(text) {
  const parts = []; let part = '';
  for (const char of text) {
    if (part.length + char.length > 1000) { parts.push(part); part = ''; }
    part += char;
    if (part.length >= 600 && /[。！？.!?\n]/.test(char)) { parts.push(part); part = ''; }
  }
  if (part) parts.push(part);
  return parts;
}

export function createCloudSpeech({ synthesize, Audio, createUrl, revokeUrl }) {
  let token = 0, recording = false, audio, url, controller, timer;
  let snapshot = { id: '', status: 'idle', error: '' };
  const listeners = new Set();
  const update = patch => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); };
  function release() {
    clearTimeout(timer);
    if (audio) { audio.onplaying = audio.onended = audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); }
    if (url) revokeUrl(url);
    url = null;
  }
  function stop() { token++; controller?.abort(); release(); audio = null; update({ id: '', status: 'idle', error: '' }); }
  async function play(active) {
    try {
      timer = setTimeout(() => {
        if (active !== token) return;
        release(); update({ status: 'error', error: '音频未能开始播放，请点击朗读重试。' });
      }, 15000);
      await audio.play();
    } catch (error) {
      if (active !== token) return;
      clearTimeout(timer);
      if (error.name === 'NotAllowedError') update({ status: 'paused', error: '音频已就绪，点击继续朗读以允许播放。' });
      else { release(); update({ status: 'error', error: '音频播放失败，请点击朗读重试。' }); }
    }
  }
  async function speak(id, text) {
    stop();
    if (recording) { update({ id, status: 'error', error: '正在录音，请结束录音后再朗读。' }); return; }
    const parts = cloudChunks(speechText(text));
    if (!parts.length) { update({ id, status: 'error', error: '这条回复没有可朗读的正文。' }); return; }
    const active = token;
    controller = new AbortController();
    audio = new Audio();
    const signal = controller.signal;
    async function next() {
      if (active !== token) return;
      release();
      const text = parts.shift();
      if (!text) { stop(); return; }
      update({ id, status: 'loading', error: '' });
      try {
        const blob = await synthesize(text, { signal });
        if (active !== token) return;
        url = createUrl(blob); audio.src = url;
        audio.onplaying = () => { if (active === token) { clearTimeout(timer); update({ status: 'speaking', error: '' }); } };
        audio.onended = next;
        audio.onerror = () => { if (active === token) { release(); update({ status: 'error', error: '设备无法解码音频，请点击朗读重试。' }); } };
        await play(active);
      } catch (error) {
        if (active !== token) return;
        release(); update({ status: 'error', error: error.message || '语音生成失败，请重试。' });
      }
    }
    await next();
  }
  return {
    supported: Boolean(Audio), speak, stop,
    getSnapshot: () => snapshot,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    setRecording: value => { recording = value; if (value) stop(); },
    pause: () => { if (snapshot.status === 'speaking') { audio.pause(); update({ status: 'paused' }); } },
    resume: async () => { if (snapshot.status === 'paused') await play(token); },
  };
}
