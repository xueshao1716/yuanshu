import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspaceApi, handleWsDeliveries, sniffImageMime } from '../../engine/workspace-api.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('图片按文件头判 MIME：.jpg 里装 PNG 以 PNG 为准', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-mime-'));
  const fake = path.join(dir, 'a.jpg'); fs.writeFileSync(fake, PNG);
  const real = path.join(dir, 'b.jpg'); fs.writeFileSync(real, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  const txt = path.join(dir, 'c.txt'); fs.writeFileSync(txt, PNG);
  assert.equal(sniffImageMime(fake, '.jpg'), 'image/png');
  assert.equal(sniffImageMime(real, '.jpg'), 'image/jpeg');
  assert.equal(sniffImageMime(txt, '.txt'), '');
  assert.equal(sniffImageMime(path.join(dir, 'nope.png'), '.png'), '');
});

test('交付列表：没有入口文件的目录不给必然 404 的 url', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-deliv-'));
  const d = path.join(root, '交付');
  fs.mkdirSync(path.join(d, '空目录'), { recursive: true });
  fs.mkdirSync(path.join(d, '网站'), { recursive: true }); fs.writeFileSync(path.join(d, '网站', 'index.html'), '<p>x</p>');
  fs.writeFileSync(path.join(d, 'a.png'), PNG);
  initWorkspaceApi({ wsRoot: root });
  let body; await handleWsDeliveries({ writeHead() {}, end(s) { body = JSON.parse(s); }, setHeader() {} });
  const by = Object.fromEntries(body.deliveries.map(x => [x.name, x]));
  assert.equal(by['空目录'].url, '');
  assert.match(by['网站'].url, /index\.html/);
  assert.match(by['a.png'].url, /a\.png/);
});
