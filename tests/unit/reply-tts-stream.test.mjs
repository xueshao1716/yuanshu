import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReplyTts } from '../../engine/reply-tts.mjs';
import { voiceSession } from '../../engine/chat-voice-provider.mjs';

function fixture() {
  const sockets = [];
  const service = createReplyTts({ getModelList: () => [{ provider: 'stepfun-plan', id: 'stepaudio-2.5-tts' }],
    readStore: () => ({}), resolveAuth: () => ({ key: 'secret', baseUrl: 'https://api.stepfun.com/step_plan/v1' }),
    connectStream: config => {
      const ws = new EventEmitter(); ws.readyState = 1; ws.sent = []; ws.config = config;
      ws.send = raw => ws.sent.push(JSON.parse(raw)); ws.terminate = () => { ws.terminated = true; };
      sockets.push(ws); return ws;
    },
  });
  const res = new EventEmitter(); res.headersSent = false; res.destroyed = false; res.data = []; res.writableLength = 0;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  res.write = data => { res.data.push(JSON.parse(String(data))); return true; }; res.end = () => { res.ended = true; };
  const receive = event => sockets[0].emit('message', Buffer.from(JSON.stringify(event)), false);
  return { service, sockets, res, receive };
}
test('cloud and call share one voice and stream capability is explicit', () => {
  const { service } = fixture();
  assert.equal(service.capabilities().voice, voiceSession.voice);
  assert.equal(service.capabilities().voiceLabel, '邻家姐姐');
  assert.equal(service.capabilities().streaming, true);
});
test('stream emits PCM before done and never replays the provider full-audio field', async () => {
  const { service, res, sockets, receive } = fixture();
  assert.equal(typeof service.handleStream, 'function');
  const pending = service.handleStream(res, { text: '你好。' });
  receive({ type: 'tts.connection.done', data: { session_id: 'one' } });
  assert.equal(sockets[0].sent[0].data.voice_id, voiceSession.voice);
  assert.equal(sockets[0].sent[0].data.response_format, 'pcm');
  assert.equal(sockets[0].sent.length, 1, 'wait for created before sending text');
  receive({ type: 'tts.response.created', data: { session_id: 'one' } });
  assert.deepEqual(sockets[0].sent.slice(1).map(e => e.type), ['tts.text.delta', 'tts.text.done']);
  receive({ type: 'tts.response.audio.delta', data: { audio: 'AAAAAA==' } });
  assert.equal(res.data[0].type, 'audio'); assert.equal(res.ended, undefined);
  receive({ type: 'tts.response.audio.done', data: { audio: 'AAAAAA==' } });
  await pending;
  assert.deepEqual(res.data.map(e => e.type), ['audio', 'done']);
  assert.equal(sockets[0].terminated, true); assert.equal(res.listenerCount('close'), 0);
});
test('stream disconnect, invalid text, protocol errors and concurrency are bounded', async () => {
  const f = fixture(); assert.equal(typeof f.service.handleStream, 'function');
  await f.service.handleStream(f.res, { text: 'x'.repeat(201) }); assert.equal(f.res.status, 400);
  const g = fixture(), pending = g.service.handleStream(g.res, { text: '你好' });
  g.res.destroyed = true; g.res.emit('close'); await pending;
  assert.equal(g.sockets[0].terminated, true);
  const h = fixture(), failed = h.service.handleStream(h.res, { text: '你好' });
  h.sockets[0].emit('error', new Error('private-key-must-not-leak'));
  await failed; assert.equal(h.res.status, 502);
  assert.ok(!JSON.stringify(h.res.data).includes('private-key'));
});
