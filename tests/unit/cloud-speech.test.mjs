import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

test('mobile UI offers explicit cloud mode and does not gate it on device synthesis', () => {
  const file = new URL('../../frontend/src/components/SpeechSettings.tsx', import.meta.url);
  assert.ok(fs.existsSync(file), 'dedicated speech settings are implemented');
  const ui = fs.readFileSync(file, 'utf8');
  const wiring = fs.readFileSync(new URL('../../frontend/src/lib/speech.ts', import.meta.url), 'utf8');
  assert.ok(ui.includes('aria-label="朗读通道"'));
  assert.ok(ui.includes('正文发送给阶跃'));
  assert.ok(wiring.includes("'/api/tts'"));
  assert.ok(wiring.includes("'/api/tts/capabilities'"));
  assert.ok(wiring.includes('getToken()'));
});

test('TTS uses configured StepFun endpoint and model, never accepts a client endpoint', async () => {
  const { createReplyTts } = await import('../../engine/reply-tts.mjs');
  let request;
  const service = createReplyTts({
    getModelList: () => [{ provider: 'stepfun-plan', id: 'stepaudio-2.5-tts' }],
    readStore: () => ({ 'stepfun-plan': { baseUrl: 'https://api.stepfun.com/step_plan/v1' } }),
    resolveAuth: () => ({ key: 'private-test-key' }),
    request: async (url, options) => { request = { url, ...options }; return { ok: true, buffer: () => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(120)]) }; },
  });
  assert.equal(service.capabilities().available, true);
  assert.equal(service.capabilities().voice, 'linjiajiejie');
  assert.equal(service.capabilities().voiceLabel, '邻家姐姐');
  assert.ok(!JSON.stringify(service.capabilities()).includes('private-test-key'));
  const result = await service.synthesize({ text: '你好', url: 'http://evil', model: 'wrong' });
  assert.equal(request.url, 'https://api.stepfun.com/step_plan/v1/audio/speech');
  assert.equal(JSON.parse(request.body).model, 'stepaudio-2.5-tts');
  assert.equal(JSON.parse(request.body).input, '你好');
  assert.equal(JSON.parse(request.body).voice, service.capabilities().voice);
  assert.equal(result.model, 'stepaudio-2.5-tts');
  await assert.rejects(service.synthesize({ text: 'x'.repeat(2001) }), /2000/);
  await assert.rejects(service.synthesize({ text: {} }), /正文/);
});

test('missing config, upstream failure and fake audio are explicit, without provider fallback', async () => {
  const { createReplyTts } = await import('../../engine/reply-tts.mjs');
  const base = { getModelList: () => [{ provider: 'stepfun-plan', id: 'stepaudio-2.5-tts' }], readStore: () => ({}), resolveAuth: () => ({ key: 'secret', baseUrl: 'https://api.stepfun.com/step_plan/v1' }) };
  const none = createReplyTts({ ...base, resolveAuth: () => null });
  assert.equal(none.capabilities().available, false);
  await assert.rejects(none.synthesize({ text: '你好' }), /未配置/);
  let calls = 0;
  const fail = createReplyTts({ ...base, request: async () => { calls++; return { ok: false, status: 429 }; } });
  await assert.rejects(fail.synthesize({ text: '你好' }), /429/); assert.equal(calls, 1);
  const fake = createReplyTts({ ...base, request: async () => ({ ok: true, buffer: () => Buffer.from('{"error":"not audio"}'.repeat(20)) }) });
  await assert.rejects(fake.synthesize({ text: '你好' }), /音频/);
});

test('TTS HTTP handler cancels on disconnect and bounds concurrent synthesis', async () => {
  const { createReplyTts } = await import('../../engine/reply-tts.mjs');
  let signals = [], releases = [];
  const service = createReplyTts({ getModelList: () => [{ provider: 'stepfun-plan', id: 'stepaudio-2.5-tts' }], readStore: () => ({}), resolveAuth: () => ({ key: 'secret' }), request: (_, options) => new Promise(resolve => { signals.push(options.signal); releases.push(() => resolve({ ok: true, buffer: () => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(120)]) })); }) });
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => {}; res.destroyed = false;
  const first = service.handle(res, { text: '测试' });
  res.destroyed = true; res.emit('close'); assert.equal(signals[0].aborted, true);
  const second = service.synthesize({ text: '第二' });
  await assert.rejects(service.synthesize({ text: '第三' }), /繁忙/);
  releases.forEach(fn => fn()); await first; await second;
  assert.equal(res.listenerCount('close'), 0);
});

function audioFixture(synthesize) {
  const audios = [], revoked = [];
  class Audio {
    constructor() { audios.push(this); }
    play() { this.onplaying?.(); return Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  }
  return { audios, revoked, options: { synthesize, Audio, createUrl: () => 'blob:audio', revokeUrl: url => revoked.push(url) } };
}

test('cloud speech works without device synthesis; pause, resume and recording cancel', async () => {
  const { createCloudSpeech } = await import('../../frontend/src/lib/cloud-speech.mjs');
  const texts = [];
  const f = audioFixture(async text => { texts.push(text); return new Blob(['audio']); });
  const speech = createCloudSpeech(f.options);
  await speech.speak('one', '你好。```js\nsecret()\n```');
  assert.equal(speech.getSnapshot().status, 'speaking'); assert.deepEqual(texts, ['你好。']);
  speech.pause(); assert.equal(speech.getSnapshot().status, 'paused');
  await speech.resume(); assert.equal(speech.getSnapshot().status, 'speaking');
  speech.setRecording(true); assert.equal(speech.getSnapshot().status, 'idle'); assert.equal(f.revoked.length, 1);
  await speech.speak('two', '测试'); assert.match(speech.getSnapshot().error, /录音/);
});

test('late cloud responses cannot play after stop; long prose is sequential and never truncated', async () => {
  const { createCloudSpeech, cloudChunks } = await import('../../frontend/src/lib/cloud-speech.mjs');
  assert.equal(cloudChunks('长'.repeat(2500)).join(''), '长'.repeat(2500));
  assert.ok(cloudChunks('😀'.repeat(2000)).every(x => x.length <= 2000));
  let release, signal;
  const f = audioFixture((_, options) => { signal = options.signal; return new Promise(r => release = r); });
  const speech = createCloudSpeech(f.options);
  const pending = speech.speak('one', '测试'); speech.stop(); release(new Blob(['old'])); await pending;
  assert.equal(signal.aborted, true); assert.equal(f.audios[0].src, undefined); assert.equal(speech.getSnapshot().status, 'idle');
});

test('autoplay denial retains prepared audio for a tap to resume, without another paid call', async () => {
  const { createCloudSpeech } = await import('../../frontend/src/lib/cloud-speech.mjs');
  let requests = 0;
  const f = audioFixture(async () => { requests++; return new Blob(['audio']); });
  f.options.Audio.prototype.play = function () { return Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })); };
  const speech = createCloudSpeech(f.options);
  await speech.speak('one', '你好');
  assert.equal(speech.getSnapshot().status, 'paused'); assert.match(speech.getSnapshot().error, /点击/);
  f.audios[0].play = async () => f.audios[0].onplaying();
  await speech.resume(); assert.equal(requests, 1); assert.equal(speech.getSnapshot().status, 'speaking'); speech.stop();
});

test('long reply synthesizes each next chunk only after playback ends and releases every URL', async () => {
  const { createCloudSpeech } = await import('../../frontend/src/lib/cloud-speech.mjs');
  const texts = [], text = '长'.repeat(2500);
  const f = audioFixture(async part => { texts.push(part); return new Blob(['audio']); });
  const speech = createCloudSpeech(f.options);
  await speech.speak('long', text);
  assert.equal(texts.length, 1);
  await f.audios[0].onended();
  assert.equal(texts.length, 2);
  await f.audios[0].onended();
  assert.equal(texts.length, 3);
  await f.audios[0].onended();
  assert.equal(texts.join(''), text);
  assert.equal(speech.getSnapshot().status, 'idle');
  assert.equal(f.revoked.length, 3);
});
