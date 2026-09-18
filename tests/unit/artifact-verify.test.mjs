// 确定性产物验证的测试：0 字节、假文件、魔数不符都要判 FAIL——而且不需要模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyArtifactFiles } from '../../engine/verifier.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-artifact-verify-'));

test('真 PNG / 真 MP4 判 PASS（查体积 + 文件头）', () => {
  const root = tmp();
  const png = path.join(root, 'a.png');
  fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096)]));
  const mp4 = path.join(root, 'b.mp4');
  fs.writeFileSync(mp4, Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(20000)]));
  const v = verifyArtifactFiles([png, mp4]);
  assert.equal(v.verdict, 'PASS');
  assert.equal(v.failures.length, 0);
  assert.match(v.evidence, /文件头对得上/);
});

test('0 字节 / 过小视频 / 错误页 / 改名假货 一律 FAIL', () => {
  const root = tmp();
  const empty = path.join(root, 'empty.png');
  fs.writeFileSync(empty, Buffer.alloc(0));
  const tiny = path.join(root, 'tiny.mp4');
  fs.writeFileSync(tiny, Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(100)]));   // < 10KB
  const html = path.join(root, 'page.png');
  fs.writeFileSync(html, Buffer.concat([Buffer.from('<html><body>403 Forbidden'), Buffer.alloc(2000)]));
  const renamed = path.join(root, 'fake.png');
  fs.writeFileSync(renamed, Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(4096)])); // 真 mp4 改叫 png

  const v = verifyArtifactFiles([empty, tiny, html, renamed]);
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.failures.join('；'), /只有 0 字节/);
  assert.match(v.failures.join('；'), /至少要有 10240/);
  assert.match(v.failures.join('；'), /与文件头不符/);
});

test('文件不存在 / 是目录 / 没给路径 分别给 FAIL 与 UNVERIFIED（不猜）', () => {
  const root = tmp();
  const dir = path.join(root, 'adir');
  fs.mkdirSync(dir);
  const miss = verifyArtifactFiles([path.join(root, 'nope.png')]);
  assert.equal(miss.verdict, 'FAIL');
  assert.match(miss.evidence, /文件不存在/);
  assert.equal(verifyArtifactFiles([dir]).verdict, 'FAIL');
  assert.equal(verifyArtifactFiles([]).verdict, 'UNVERIFIED', '没有产物可验时如实说 UNVERIFIED');
  assert.equal(verifyArtifactFiles(['https://example.com/a.png']).verdict, 'UNVERIFIED', 'URL 不在这层验（要另外抓）');
});
