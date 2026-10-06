import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runDoctor } from '../../engine/install-doctor.mjs';

const require = createRequire(import.meta.url);
const { seedWorkspace } = require('../../installer/launcher/seed-workspace.cjs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('doctor: fresh machine without keys reports models fail and missing tools warn', async () => {
  const ws = tmp('doc-ws-'); const agent = tmp('doc-ag-');
  const run = async () => ({ ok: false, out: '', err: 'not found' });
  const r = await runDoctor({ wsRoot: ws, agentDir: agent, piPackage: '', bashPath: null, port: 8787, run, platform: 'linux' });
  const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
  assert.equal(by.workspace.status, 'ok');
  assert.equal(by.models.status, 'fail');
  assert.equal(by.persona.status, 'warn');
  for (const k of ['pi', 'dsh', 'python', 'ffmpeg', 'git', 'bash']) assert.equal(by[k].status, 'warn', k);
  assert.equal(r.summary.fail, 1);
  assert.equal(by.autostart, undefined, 'autostart only checked on windows');
});

test('doctor: complete install is all green and reports missing python libs by name', async () => {
  const ws = tmp('doc-ws-'); const agent = tmp('doc-ag-');
  fs.mkdirSync(path.join(ws, '记忆'), { recursive: true });
  fs.mkdirSync(path.join(ws, '工程', '经验库'), { recursive: true });
  fs.writeFileSync(path.join(ws, '记忆', '人格定义.json'), '{}');
  fs.writeFileSync(path.join(ws, '工程', '经验库', 'genome.json'), '{}');
  fs.writeFileSync(path.join(agent, 'auth.json'), JSON.stringify({ zhipu: { type: 'api_key', key: 'k' }, empty: { key: '' } }));
  const pi = path.join(agent, 'pi.js'); fs.writeFileSync(pi, '');
  let libs = { pptx: true, rembg: true };
  const run = async (cmd, args) => {
    if (cmd === 'python') return { ok: true, out: JSON.stringify(libs) };
    if (cmd === 'schtasks.exe') return { ok: true, out: 'yuanshu-watchdog' };
    return { ok: true, out: `${cmd} version 1\nmore` };
  };
  const opts = { wsRoot: ws, agentDir: agent, piPackage: pi, bashPath: 'C:/git/usr/bin/bash.exe', port: 8787, run, platform: 'win32' };
  let r = await runDoctor(opts);
  assert.deepEqual(r.summary, { ok: r.items.length, warn: 0, fail: 0 });
  assert.match(r.items.find((i) => i.key === 'models').detail, /1 个服务/);
  libs = { pptx: true, rembg: false };
  r = await runDoctor(opts);
  const py = r.items.find((i) => i.key === 'python');
  assert.equal(py.status, 'warn');
  assert.match(py.detail, /rembg/);
});

test('seed workspace: fills missing files and never overwrites existing data', () => {
  const tpl = tmp('seed-tpl-'); const ws = path.join(tmp('seed-ws-'), 'pi-workspace');
  fs.mkdirSync(path.join(tpl, '记忆'), { recursive: true });
  fs.writeFileSync(path.join(tpl, '记忆', '人格定义.json'), '{"name":"小语"}');
  fs.writeFileSync(path.join(tpl, '记忆.md'), 'template');
  assert.deepEqual(seedWorkspace(tpl, ws).sort(), ['记忆.md', path.join('记忆', '人格定义.json')].sort());
  fs.writeFileSync(path.join(ws, '记忆.md'), 'user data');
  fs.rmSync(path.join(ws, '记忆', '人格定义.json'));
  assert.deepEqual(seedWorkspace(tpl, ws), [path.join('记忆', '人格定义.json')]);
  assert.equal(fs.readFileSync(path.join(ws, '记忆.md'), 'utf8'), 'user data');
  assert.deepEqual(seedWorkspace(path.join(tpl, 'missing'), ws), []);
});

test('installer template carries persona and gene baseline but no private provenance', () => {
  const root = new URL('../../installer/template/workspace/', import.meta.url);
  const def = JSON.parse(fs.readFileSync(new URL('记忆/人格定义.json', root), 'utf8'));
  assert.equal(def.name, '小语');
  assert.ok(Array.isArray(def.values) && def.values.length > 0);
  assert.equal(def.provenance, undefined);
  assert.doesNotMatch(JSON.stringify(def), /曦|林心语|hermes|xi-system/i);
  const genome = JSON.parse(fs.readFileSync(new URL('工程/经验库/genome.json', root), 'utf8'));
  assert.equal(Object.keys(genome.genes).length, 11);
  for (const g of Object.values(genome.genes)) assert.equal(g.expression, g.baseline);
  assert.deepEqual(genome.observations.events, []);
});
