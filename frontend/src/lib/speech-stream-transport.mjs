export async function consumeSpeechStream(response, { onAudio, signal } = {}) {
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `流式朗读请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error('当前设备不支持流式音频。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', done = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!done) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await reader.read();
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      if (pending.length > 2 * 1024 * 1024) throw new Error('语音数据超出限制。');
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'error') throw new Error(event.error || '流式语音合成失败。');
        if (event.type === 'done') { done = true; break; }
        if (event.type !== 'audio' || event.sampleRate !== 24000 || typeof event.data !== 'string') throw new Error('语音数据格式异常。');
        if (!signal?.aborted) await onAudio(event);
      }
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!done) throw new Error('语音连接提前结束，请点击朗读重试。');
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
