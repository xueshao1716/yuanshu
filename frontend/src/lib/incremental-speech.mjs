import { speechText } from './speech-output.mjs';

function readable(text) {
  // Hold unfinished markdown tokens: later deltas can change what is visible prose.
  return speechText(text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`]*`/g, ' ').replace(/`[^`]*$/g, '')
    .replace(/!?\[[^\]]*(?:\](?:\([^)]*)?)?$/g, '').replace(/<[^>]*$/g, ''));
}

export function createIncrementalSpeech({ output, schedule = setTimeout, cancel = clearTimeout, delayMs = 650 }) {
  let id = '', raw = '', committed = '', clean = '', stopped = false, done = false, started = false, timer;
  function stop() { cancel(timer); timer = undefined; stopped = true; output.stop(); }
  function flush(force = false) {
    cancel(timer); timer = undefined;
    if (stopped || done) return;
    if (!clean.startsWith(committed)) { stop(); return; }
    let rest = clean.slice(committed.length);
    while (rest) {
      const boundary = /[。！？!?；;]|\.(?=\s|$)/.exec(rest);
      let end = boundary ? boundary.index + 1 : 0;
      if (!end && rest.length >= 100) end = 100;
      if (!end && force) end = rest.length;
      if (!end) break;
      end = Math.min(end, 160);
      if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
      const part = rest.slice(0, end);
      committed += part; rest = rest.slice(end);
      if (part.trim()) {
        if (!started) { started = true; output.begin(id); }
        output.append(part);
      }
    }
    if (rest) timer = schedule(() => flush(true), delayMs);
  }
  function update(nextId, text) {
    if (!nextId || typeof text !== 'string') return;
    if (nextId !== id) {
      output.stop(); cancel(timer); id = nextId; raw = committed = clean = ''; stopped = done = started = false;
    }
    if (stopped || done || text === raw) return;
    if (!text.startsWith(raw)) { stop(); return; }
    raw = text; clean = readable(text); flush();
  }
  return {
    update, stop,
    skip(nextId) { stop(); id = nextId; raw = committed = clean = ''; started = false; },
    finish(nextId, text) {
      update(nextId, text);
      if (stopped || done) return;
      flush(true); done = true; cancel(timer);
      if (started) output.finish();
    },
  };
}
