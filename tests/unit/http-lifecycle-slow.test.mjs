import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { observeHttpRequest } from '../../engine/http-lifecycle.mjs';

async function run(handler, opts) {
  const slow = [];
  const server = http.createServer((req, res) => {
    observeHttpRequest(req, res, 'rid', () => {}, { ...opts, onSlow: e => slow.push(e) });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/x?secret=1`);
  await res.arrayBuffer();
  await new Promise(r => setTimeout(r, 20));
  server.close(); server.closeAllConnections();
  return slow;
}

test('slow requests are reported with path only (no query)', async () => {
  const slow = await run((_req, res) => setTimeout(() => res.end('ok'), 60), { slowMs: 30 });
  assert.equal(slow.length, 1);
  assert.equal(slow[0].path, '/api/x');
  assert.ok(slow[0].durationMs >= 30);
  assert.ok(!JSON.stringify(slow[0]).includes('secret'));
});
test('fast requests and event streams are not reported', async () => {
  assert.equal((await run((_req, res) => res.end('ok'), { slowMs: 1000 })).length, 0);
  const stream = await run((_req, res) => { res.setHeader('content-type', 'text/event-stream'); setTimeout(() => res.end('x'), 60); }, { slowMs: 30 });
  assert.equal(stream.length, 0);
});
