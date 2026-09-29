import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

test('microphone is allowed only for self; Android declares on-demand audio permissions', () => {
  assert.ok(read('server.mjs').includes('microphone=(self)'));
  const manifest = read('app/src-tauri/gen/android/app/src/main/AndroidManifest.xml');
  assert.ok(manifest.includes('android.permission.RECORD_AUDIO'));
  assert.ok(manifest.includes('android.permission.MODIFY_AUDIO_SETTINGS'));
});

test('recording lifecycle handles cancellation, late permission and constructor failure', async () => {
  const { createVoiceRecorder, microphoneError, microphonePreflight } = await import('../../frontend/src/lib/voice-recorder.mjs');
  assert.match(microphoneError({ name: 'NotFoundError' }), /未检测到/);
  assert.match(microphoneError({ name: 'NotReadableError' }), /占用/);
  assert.match(microphoneError({ name: 'NotAllowedError' }), /权限/);
  assert.match(microphonePreflight({ secure: false }), /HTTPS/);
  assert.match(microphonePreflight({ secure: true, allowed: false }), /站点/);
  let resolve, stopped = 0, data = 0, state = '';
  const stream = { getTracks: () => [{ stop: () => stopped++ }] };
  class Recorder {
    static isTypeSupported() { return true; }
    mimeType = 'audio/webm'; state = 'inactive';
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['hello']) }); this.onstop?.(); }
  }
  const controller = createVoiceRecorder({ getUserMedia: () => new Promise(r => resolve = r), Recorder,
    onData: () => data++, onState: s => state = s, onError: e => assert.fail(e) });
  const pending = controller.start(); controller.stop(true); resolve(stream); await pending;
  assert.equal(stopped, 1); assert.equal(data, 0); assert.equal(state, 'idle');
  const second = controller.start(); resolve(stream); await second; controller.stop(true);
  assert.equal(data, 0); assert.equal(stopped, 2);
  const third = controller.start(); resolve(stream); await third; controller.stop();
  assert.equal(data, 1); assert.equal(stopped, 3);
  let error = '';
  const bad = createVoiceRecorder({ getUserMedia: async () => stream, Recorder: class { constructor() { throw new Error('codec'); } }, onError: e => error = e });
  await bad.start(); assert.equal(stopped, 4); assert.match(error, /codec/);
});

test('speech reads prose only, splits long text, and rejects empty code-only replies', async () => {
  const { speechText, speechChunks } = await import('../../frontend/src/lib/speech-output.mjs');
  const text = speechText('## 你好\n```js\nsecret()\n```\n[说明](https://example.com) ![图片](a.png) `npm run` D:/private/file.html');
  assert.match(text, /你好/); assert.match(text, /说明/);
  for (const part of ['secret', 'https', 'a.png', 'npm run', 'private']) assert.ok(!text.includes(part), part);
  assert.equal(speechText('```js\nsecret()\n```'), '');
  const chunks = speechChunks('好'.repeat(700));
  assert.equal(chunks.join(''), '好'.repeat(700)); assert.ok(chunks.every(x => x.length <= 180));
});

test('speech controller supports pause/resume, stale-event isolation, recording exclusion and errors', async () => {
  const { createSpeechOutput } = await import('../../frontend/src/lib/speech-output.mjs');
  const spoken = []; let paused = 0, resumed = 0;
  const synth = { cancel() {}, pause() { paused++; }, resume() { resumed++; }, getVoices: () => [], speak(u) { spoken.push(u); } };
  const voice = createSpeechOutput({ synth, Utterance: class { constructor(text) { this.text = text; } } });
  voice.speak('one', '第一句'); const old = spoken[0]; old.onstart();
  assert.equal(voice.getSnapshot().status, 'speaking');
  voice.pause(); assert.equal(paused, 1); assert.equal(voice.getSnapshot().status, 'paused');
  voice.resume(); assert.equal(resumed, 1);
  voice.speak('two', '第二句'); old.onend(); assert.equal(voice.getSnapshot().id, 'two');
  voice.setRecording(true); assert.equal(voice.getSnapshot().status, 'idle');
  voice.speak('three', '第三句'); assert.match(voice.getSnapshot().error, /录音/); assert.equal(spoken.length, 2);
  voice.setRecording(false); voice.speak('four', '第四句'); spoken.at(-1).onerror({ error: 'not-allowed' });
  assert.equal(voice.getSnapshot().status, 'error'); assert.match(voice.getSnapshot().error, /点击/);
  voice.stop(); assert.equal(voice.getSnapshot().status, 'idle');
});

test('chat speech uses the saved message ID, skips drafts, and keeps mobile controls wrapping', () => {
  const chat = read('frontend/src/components/ChatArea.tsx');
  assert.ok(chat.includes('speech.finishReply(savedId, s.text)'));
  assert.ok(chat.includes("id: savedId, role: 'assistant'"));
  assert.ok(chat.includes('if (!readAutomatically) try {'));
  assert.ok(chat.includes('() => speech.stop(), [currentSessionId]'));
  assert.ok(chat.includes('if (request !== voiceRequestRef.current) return'));
  const message = read('frontend/src/components/Message.tsx');
  assert.ok(message.includes('message-actions inline-flex flex-wrap'));
  assert.ok(message.includes('!msg.isDraft && <SpeechControls'));
  const send = read('frontend/src/components/SendBox.tsx');
  assert.ok(send.includes('controller.stop(true)'));
  assert.ok(send.includes('aria-label="取消录音"'));
  assert.ok(send.includes('if (mounted) voiceCallbackRef.current'));
  assert.ok(read('frontend/src/lib/speech.ts').includes('let auto = false'));
});

test('late stop/error from a cancelled recorder cannot deliver or cancel a new run', async () => {
  const { createVoiceRecorder } = await import('../../frontend/src/lib/voice-recorder.mjs');
  const instances = []; let delivered = 0, errors = 0, stopped = 0;
  class Recorder {
    constructor() { instances.push(this); }
    start() {}
    stop() {}
  }
  const voice = createVoiceRecorder({ getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++; } }] }), Recorder,
    onData() { delivered++; }, onError() { errors++; } });
  await voice.start(); voice.stop(); voice.stop(true);
  instances[0].ondataavailable({ data: new Blob(['old']) }); instances[0].onstop();
  assert.equal(delivered, 0);
  await voice.start(); instances[0].onerror({ error: new Error('stale') });
  assert.equal(errors, 0); assert.equal(stopped, 1);
  voice.stop(true); assert.equal(stopped, 2);
});

test('speech advances chunks, selects Chinese voice, ends cleanly, and reports unsupported devices', async () => {
  const { createSpeechOutput } = await import('../../frontend/src/lib/speech-output.mjs');
  const spoken = [], chinese = { lang: 'zh-CN', name: 'device' };
  const speech = createSpeechOutput({ synth: { cancel() {}, getVoices: () => [chinese], speak(u) { spoken.push(u); } },
    Utterance: class { constructor(text) { this.text = text; } } });
  speech.speak('long', '第一段。第二段。');
  assert.equal(spoken.length, 1); assert.equal(spoken[0].voice, chinese);
  spoken[0].onstart(); spoken[0].onend(); assert.equal(spoken.length, 2);
  spoken[1].onstart(); spoken[1].onend(); assert.equal(speech.getSnapshot().status, 'idle');
  const missing = createSpeechOutput({}); missing.speak('none', '正文');
  assert.equal(missing.supported, false); assert.match(missing.getSnapshot().error, /不支持/);
});

test('starting a new reply clears the device paused state left by a stopped reply', async () => {
  const { createSpeechOutput } = await import('../../frontend/src/lib/speech-output.mjs');
  const synth = { paused: false, cancel() {}, getVoices: () => [],
    pause() { this.paused = true; }, resume() { this.paused = false; },
    speak(u) { if (!this.paused) u.onstart(); } };
  const speech = createSpeechOutput({ synth, Utterance: class {} });
  speech.speak('first', '第一句'); speech.pause(); speech.stop();
  speech.speak('second', '第二句');
  const state = speech.getSnapshot(); speech.stop();
  assert.equal(state.status, 'speaking');
});

test('speech uses the selected installed voice and its language for every chunk', async t => {
  const { createSpeechOutput } = await import('../../frontend/src/lib/speech-output.mjs');
  const chinese = { name: '中文', lang: 'zh-CN' }, selected = { name: 'English', lang: 'en-US' }, spoken = [];
  const speech = createSpeechOutput({ synth: { cancel() {}, getVoices: () => [chinese, selected], speak(u) { spoken.push(u); } },
    Utterance: class {}, getVoice: () => selected });
  t.after(() => speech.stop());
  speech.speak('selected', 'First. Second.');
  assert.equal(spoken[0].voice, selected);
  assert.equal(spoken[0].lang, 'en-US');
  spoken[0].onend();
  assert.equal(spoken[1].voice, selected);
});
