import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

async function load(name) {
  const url = new URL(`../../frontend/src/lib/${name}.mjs`, import.meta.url);
  assert.ok(fs.existsSync(url), `${name} exists`); return import(url);
}
test('PCM plays as chunks arrive, schedules in order, pauses and cancels all sources', async () => {
  const { createSpeechPcmPlayer } = await load('speech-pcm-player');
  const sources = [], states = [];
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; }
    createBuffer(_, length, rate) { return { duration: length / rate, copyToChannel() {} }; }
    createBufferSource() { const source = { connect() {}, disconnect() {}, start(at) { this.at = at; }, stop() { this.stopped = true; } }; sources.push(source); return source; }
    resume() { this.state = 'running'; this.onstatechange?.(); return Promise.resolve(); }
    suspend() { this.state = 'suspended'; this.onstatechange?.(); return Promise.resolve(); }
  }
  const player = createSpeechPcmPlayer({ AudioContext, onState: value => states.push(value) });
  await player.unlock(); player.push('AAAAAA=='); player.push('AAAAAA==');
  assert.equal(sources.length, 2); assert.ok(sources[1].at > sources[0].at);
  await player.pause(); assert.equal(player.paused, true);
  await player.resume(); assert.equal(player.paused, false);
  player.stop(); assert.ok(sources.every(s => s.stopped)); assert.equal(player.pendingSeconds(), 0);
});
test('stream transport consumes split frames before response finishes and requires done', async () => {
  const { consumeSpeechStream } = await load('speech-stream-transport');
  const events = [], encoder = new TextEncoder(); let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  const response = new Response(body);
  const result = consumeSpeechStream(response, { onAudio: e => events.push(e) });
  controller.enqueue(encoder.encode('{"type":"audio","data":"AAAA'));
  controller.enqueue(encoder.encode('AA==","sampleRate":24000}\n'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(events.length, 1);
  controller.enqueue(encoder.encode('{"type":"done"}\n')); controller.close(); await result;
  await assert.rejects(consumeSpeechStream(new Response('{"type":"audio","data":"AAAAAA==","sampleRate":24000}\n'), { onAudio() {} }), /提前结束/);
});
test('cloud incremental audio starts early, prefetches while playing and aborts late callbacks', async () => {
  const { createStreamingSpeech } = await load('streaming-speech');
  const requests = [], heard = []; let release, signal, receive;
  const player = { supported: true, paused: false, unlock() {}, stop() {}, pause() {}, resume() {}, pendingSeconds: () => 0, push: data => heard.push(data) };
  const output = createStreamingSpeech({ createPlayer: () => player, synthesize: async (text, options) => {
    requests.push(text); signal = options.signal; receive = options.onAudio;
    options.onAudio({ data: text, sampleRate: 24000 });
    await new Promise(resolve => { release = resolve; });
  } });
  output.begin('a'); output.append('第一句。'); output.append('第二句。');
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(heard, ['第一句。']);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['第一句。', '第二句。']);
  output.stop(); assert.equal(signal.aborted, true); receive({ data: 'late' }); release();
  await new Promise(resolve => setImmediate(resolve)); assert.ok(!heard.includes('late'));
  assert.equal(output.getSnapshot().status, 'idle');
});
test('device reader queues incremental sentences without interrupting current utterance', async () => {
  const { createSpeechOutput } = await import('../../frontend/src/lib/speech-output.mjs');
  const utterances = []; let cancels = 0;
  const synth = { cancel: () => cancels++, getVoices: () => [], speak: u => { utterances.push(u); u.onstart(); }, resume() {} };
  const output = createSpeechOutput({ synth, Utterance: class { constructor(text) { this.text = text; } } });
  assert.equal(typeof output.begin, 'function');
  output.begin('a'); const originalCancels = cancels;
  output.append('第一句。'); output.append('第二句。'); output.finish();
  assert.equal(utterances.length, 1); assert.equal(cancels, originalCancels);
  utterances[0].onend(); assert.equal(utterances[1].text, '第二句。');
  utterances[1].onend(); assert.equal(output.getSnapshot().status, 'idle');
});
test('suspended playback exposes resume without waiting for a pending unlock promise', async () => {
  const { createStreamingSpeech } = await load('streaming-speech');
  const output = createStreamingSpeech({
    createPlayer: () => ({ supported: true, paused: true, stop() {}, pendingSeconds: () => 0, unlock: () => new Promise(() => {}) }),
    synthesize: async () => {},
  });
  output.begin('blocked');
  assert.equal(output.getSnapshot().status, 'paused');
  assert.match(output.getSnapshot().error, /继续/); output.stop();
});
