const storageKey = 'yuanshu_speech_voice';
const voiceId = voice => voice.voiceURI || `${voice.name}:${voice.lang}`;

// Only installed voices are selectable. An unavailable saved voice falls back to
// the device default, but may become available after voiceschanged fires.
export function createDeviceVoices({ synth, storage } = {}) {
  let preferred = '';
  try { preferred = storage?.getItem(storageKey) || ''; } catch {}
  let snapshot = { voices: [], selected: '' };
  const listeners = new Set();
  const installed = () => { try { return synth?.getVoices() || []; } catch { return []; } };
  function refresh() {
    const unique = new Map(installed().map(voice => [voiceId(voice), { id: voiceId(voice), name: voice.name, lang: voice.lang }]));
    const next = { voices: [...unique.values()], selected: unique.has(preferred) ? preferred : '' };
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    listeners.forEach(fn => fn());
  }
  refresh();
  return {
    getSnapshot: () => snapshot,
    getVoice: () => installed().find(voice => voiceId(voice) === preferred) || null,
    select(id) {
      if (id && !installed().some(voice => voiceId(voice) === id)) return false;
      preferred = id;
      try { storage?.setItem(storageKey, id); } catch {}
      refresh();
      return true;
    },
    subscribe(fn) {
      if (!listeners.size) synth?.addEventListener?.('voiceschanged', refresh);
      listeners.add(fn);
      refresh();
      return () => {
        listeners.delete(fn);
        if (!listeners.size) synth?.removeEventListener?.('voiceschanged', refresh);
      };
    },
  };
}
