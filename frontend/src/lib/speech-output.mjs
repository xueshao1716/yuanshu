export function speechText(value = '') {
  return String(value)
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+|[A-Za-z]:[\\/][^\s，。；]+|\/(?:[^\s/]+\/)+[^\s，。；]*/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^[\s#>*|\-]+/gm, '').replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ').trim();
}

export function speechChunks(text) {
  const chunks = [];
  for (const sentence of text.match(/[^。！？.!?\n]+[。！？.!?\n]?/g) || []) {
    for (let i = 0; i < sentence.length; i += 180) chunks.push(sentence.slice(i, i + 180));
  }
  return chunks;
}

// Device adapter is injected, so future model audio need not change message UI.
export function createSpeechOutput({ synth, Utterance, getVoice = () => null }) {
  let token = 0, recording = false, utterance = null, timer, appendText, finishText, pump;
  let snapshot = { id: '', status: 'idle', error: '' };
  const listeners = new Set();
  const update = patch => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); };
  const supported = Boolean(synth && Utterance);
  const clear = () => { token++; clearTimeout(timer); utterance = null; synth?.cancel(); };
  function stop() { clear(); update({ id: '', status: 'idle', error: '' }); }
  function speak(id, text, streaming = false) {
    clear();
    if (recording) { update({ id, status: 'error', error: '正在录音，请结束录音后再朗读。' }); return; }
    if (!supported) { update({ id, status: 'error', error: '当前设备不支持系统朗读，请使用系统浏览器或更新客户端。' }); return; }
    const chunks = speechChunks(speechText(text));
    if (!chunks.length && !streaming) { update({ id, status: 'error', error: '这条回复没有可朗读的正文。' }); return; }
    let finished = !streaming, busy = false;
    const active = token;
    update({ id, status: 'loading', error: '' });
    const fail = error => {
      if (active !== token) return;
      clear();
      update({ status: 'error', error: error === 'not-allowed' ? '播放被设备拦截，请点击朗读按钮播放。' : '系统朗读未能播放，请检查设备中文语音包，或点击朗读重试。' });
    };
    function next() {
      if (active !== token || busy || snapshot.status === 'paused') return;
      const part = chunks.shift();
      if (!part) { if (finished) stop(); else update({ status: 'loading' }); return; }
      busy = true;
      try {
        const u = utterance = new Utterance(part);
        u.lang = 'zh-CN'; u.rate = 1;
        const voices = synth.getVoices();
        const selected = getVoice() || voices.find(v => /^zh[-_]CN/i.test(v.lang)) || voices.find(v => /^zh/i.test(v.lang));
        if (selected) { u.voice = selected; u.lang = selected.lang; }
        u.onstart = () => { if (active === token) { clearTimeout(timer); update({ status: 'speaking' }); } };
        u.onend = () => { if (active === token) { clearTimeout(timer); busy = false; next(); } };
        u.onerror = e => fail(e.error);
        timer = setTimeout(() => fail('timeout'), 15000);
        // cancel() empties the queue but does not reset the device's paused flag.
        if (synth.paused) synth.resume();
        synth.speak(u);
      } catch { fail('failed'); }
    }
    pump = next;
    appendText = value => { if (active === token && !finished) { chunks.push(...speechChunks(speechText(value))); next(); } };
    finishText = () => { if (active === token) { finished = true; next(); } };
    next();
  }
  return {
    supported, speak, stop,
    begin: id => speak(id, '', true), append: text => appendText?.(text), finish: () => finishText?.(),
    getSnapshot: () => snapshot,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    setRecording: value => { recording = value; if (value) stop(); },
    pause: () => { if (snapshot.status === 'speaking') { synth.pause(); update({ status: 'paused' }); } },
    resume: () => { if (snapshot.status === 'paused') { synth.resume(); update({ status: 'speaking' }); pump?.(); } },
  };
}
