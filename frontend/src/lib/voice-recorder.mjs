export function microphonePreflight({ secure, allowed = true, media = true, recorder = true }) {
  if (!secure) return '语音输入需要 HTTPS；电脑本机可用 localhost 或 127.0.0.1。请勿通过普通 HTTP 局域网地址录音。';
  if (!allowed) return '当前站点策略禁止麦克风，请刷新页面；仍失败请联系管理员更新服务。';
  if (!media || !recorder) return '当前浏览器或客户端不支持录音，请更新客户端或使用系统浏览器。';
  return '';
}

export function microphoneError(error) {
  const names = {
    NotAllowedError: '麦克风权限被拒绝。请在地址栏的站点权限中允许麦克风；安装版请检查系统应用权限，然后重试。',
    SecurityError: '麦克风被安全策略禁用，请检查站点权限及系统隐私设置。',
    NotFoundError: '未检测到麦克风，请连接设备后重试。',
    NotReadableError: '麦克风被占用或无法启动，请关闭其他录音应用，并检查系统麦克风权限。',
    AbortError: '录音启动被中断，请重试。',
  };
  return names[error?.name] || `录音失败：${error?.message || '设备不支持当前录音格式'}`;
}

// Owns tracks even when permission resolves after cancellation or recorder creation fails.
export function createVoiceRecorder({ getUserMedia, Recorder, onData = () => {}, onState = () => {}, onError = () => {} }) {
  let epoch = 0, state = 'idle', current = null;
  const pending = new Set();
  const setState = next => { state = next; onState(next); };
  const release = run => {
    if (run.released) return;
    run.released = true;
    run.stream.getTracks().forEach(track => track.stop());
  };
  function stop(cancel = false) {
    epoch++;
    if (cancel) for (const run of pending) run.cancelled = true;
    const run = current;
    current = null;
    if (run) {
      run.cancelled = cancel;
      try { run.rec.stop(); } catch { release(run); }
      release(run);
    }
    setState('idle');
  }
  async function start() {
    if (state !== 'idle') return;
    const id = ++epoch;
    setState('requesting');
    let run;
    try {
      const stream = await getUserMedia({ audio: true });
      run = { stream, released: false, cancelled: false, chunks: [], rec: null };
      if (id !== epoch) { release(run); return; }
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
        .find(type => Recorder.isTypeSupported?.(type));
      const rec = run.rec = new Recorder(stream, mime ? { mimeType: mime } : undefined);
      pending.add(run);
      rec.ondataavailable = e => { if (e.data.size) run.chunks.push(e.data); };
      rec.onerror = e => { if (current === run) { stop(true); onError(microphoneError(e.error)); } };
      rec.onstop = () => {
        pending.delete(run);
        release(run);
        if (current === run) { current = null; setState('idle'); }
        if (!run.cancelled) {
          const blob = new Blob(run.chunks, { type: rec.mimeType || mime || 'audio/webm' });
          if (blob.size) onData(blob);
          else onError('没有录到声音，请重新录音。');
        }
      };
      current = run;
      rec.start();
      setState('recording');
    } catch (error) {
      if (run) { run.cancelled = true; pending.delete(run); release(run); }
      if (id !== epoch) return;
      current = null; setState('idle'); onError(microphoneError(error));
    }
  }
  return { start, stop };
}
