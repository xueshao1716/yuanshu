import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { initMediaApi, generateMediaAsync } from '../../engine/media-api.mjs';
import { readImageDimensions, verifyImageDimensions } from '../../engine/image-dimensions.mjs';

function pngHeader(width, height) {
  const b = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b);
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}
test('host passes 2:3 through the real HTTP request and measures the returned PNG, not model claims', async t => {
  const requests = [];
  let width = 1024, height = 1536;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: pngHeader(width, height).toString('base64') }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  initMediaApi({ resolveAuth: () => ({ key: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }),
    readJsonFile: () => ({}), getModelList: () => [{ provider: 'fixture', id: 'fixture-image', capabilities: { image: true } }] });
  const result = await generateMediaAsync({ type: 'image', aspectRatio: '2:3' }, 'a leaf');
  assert.equal(requests[0].size, '1024x1536');
  assert.equal(result.verification?.actualSize, '1024x1536');
  assert.equal(result.verification.status, 'matched');
  height = 1024;
  const mismatch = await generateMediaAsync({ type: 'image', size: '1024x1536' }, 'a leaf');
  assert.equal(mismatch.verification.status, 'mismatch');
  assert.equal(mismatch.verification.actualSize, '1024x1024');
});

test('dimension facts distinguish exact pixels, exact ratio, near ratio and unknown formats', async () => {
  const uri = (w, h) => `data:image/png;base64,${pngHeader(w, h).toString('base64')}`;
  const exact = await verifyImageDimensions(uri(832, 1248), '1024x1536', '2:3');
  assert.equal(exact.exactSize, false);
  assert.equal(exact.ratioExact, true);
  const near = await verifyImageDimensions(uri(1312, 736), '1472x832', '16:9');
  assert.equal(near.status, 'matched');
  assert.equal(near.ratioExact, false);
  assert.equal(near.requestedAspectRatio, '16:9');
  assert.equal((await verifyImageDimensions('data:image/png;base64,aGVsbG8=', '1024x1024')).status, 'unverified');
  assert.equal(readImageDimensions(Buffer.from('not an image')), null);
});

test('JPEG, WebP headers and truncated inputs are parsed safely', () => {
  const jpeg = Buffer.from('ffd8ffe000040000ffc000110801e0028003011100021100031100ffd9', 'hex');
  assert.deepEqual(readImageDimensions(jpeg), { width: 640, height: 480 });
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBPVP8X', 8);
  webp.writeUIntLE(831, 24, 3); webp.writeUIntLE(1247, 27, 3);
  assert.deepEqual(readImageDimensions(webp), { width: 832, height: 1248 });
  const lossless = Buffer.alloc(25); lossless.write('RIFF'); lossless.write('WEBPVP8L', 8); lossless[20] = 0x2f;
  lossless.writeUInt32LE(639 | (479 << 14), 21);
  assert.deepEqual(readImageDimensions(lossless), { width: 640, height: 480 });
  const invalid = Buffer.from(webp); invalid.write('VP8 ', 12);
  assert.equal(readImageDimensions(invalid), null);
  for (const bytes of [jpeg, webp, lossless]) for (let n = 0; n < 20; n++) assert.equal(readImageDimensions(bytes.subarray(0, n)), null);
});

test('remote dimension probe reads actual header and fails closed on HTTP or malformed content', async t => {
  let seenRange;
  const server = http.createServer((req, res) => {
    seenRange = req.headers.range;
    if (req.url === '/bad') { res.writeHead(403); return res.end(); }
    if (req.url === '/unknown') return res.end('hello');
    res.end(pngHeader(600, 900));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await verifyImageDimensions(base + '/image', '1024x1536')).actualSize, '600x900');
  assert.equal(seenRange, 'bytes=0-262143');
  for (const suffix of ['/bad', '/unknown']) assert.equal((await verifyImageDimensions(base + suffix, '1024x1536')).status, 'unverified');
});
