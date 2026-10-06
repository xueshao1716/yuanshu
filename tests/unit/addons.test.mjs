import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { ADDONS, listAddons, installAddon, FFMPEG_SHA } from '../../engine/addons.mjs';

const tmpEnv = () => ({ YUANSHU_RUNTIME: fs.mkdtempSync(path.join(os.tmpdir(), 'addon-rt-')), PATH: '' });

test('addons: four optional components, each with size and use described', () => {
  assert.deepEqual(ADDONS.map((a) => a.id), ['media', 'cutout', 'data', 'pdf']);
  for (const a of ADDONS) { assert.ok(a.label && a.size && a.use, a.id); }
  for (const v of Object.values(FFMPEG_SHA)) assert.match(v, /^[0-9a-f]{64}$/);
});

test('addons: list reports installed state from probes without touching the network', async () => {
  const env = tmpEnv();
  const have = { pandas: true, numpy: true, fitz: false };
  const run = async (cmd, args) => {
    if (cmd !== 'python') return { ok: false, out: '', err: 'x' };
    const asked = JSON.parse(args[1].match(/for n in (\[.*?\])/)[1]);
    return { ok: true, out: JSON.stringify(Object.fromEntries(asked.map((m) => [m, !!have[m]]))) };
  };
  const by = Object.fromEntries((await listAddons({ run, env })).map((a) => [a.id, a.installed]));
  assert.deepEqual(by, { media: false, cutout: false, data: true, pdf: false });
});

test('addons: media install tries mirrors in order, gunzips, and rejects a bad checksum', async () => {
  const env = tmpEnv();
  const payload = Buffer.from('not really ffmpeg');
  const gz = zlib.gzipSync(payload);
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return new Response(gz, { status: 200 }); };
  let ffOk = false;
  const run = async (cmd) => ({ ok: cmd === 'ffmpeg' || cmd === 'ffprobe' ? ffOk : false, out: 'ffmpeg version x', err: '' });
  await assert.rejects(installAddon('media', { run, env, fetchImpl }), /校验失败|下载失败/);
  assert.ok(seen[0].includes('npmmirror.com'), '先走国内镜像');
  assert.ok(seen.some((u) => u.includes('github.com')), '镜像失败退回官方');
  assert.equal(fs.existsSync(path.join(env.YUANSHU_RUNTIME, 'ffmpeg', 'bin', 'ffmpeg.exe')), false, '校验失败不落盘');
  ffOk = true;
  assert.deepEqual(await installAddon('media', { run, env, fetchImpl }), { id: 'media', already: true });
});

test('addons: pip components fall back across indexes and verify after install', async () => {
  const env = tmpEnv();
  const calls = []; let installed = false;
  const run = async (cmd, args) => {
    if (args[0] === '-c') return { ok: true, out: JSON.stringify({ pandas: installed, numpy: installed }) };
    calls.push(args[args.indexOf('-i') + 1]);
    if (calls.length === 1) return { ok: false, out: '', err: 'mirror down' };
    installed = true; return { ok: true, out: '' };
  };
  const log = [];
  assert.deepEqual(await installAddon('data', { run, env, log: (m) => log.push(m) }), { id: 'data', already: false });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /aliyun/);
  await assert.rejects(installAddon('nope', { run, env }), /没有这个组件/);
});
