import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createUpdateRestart, watchdogAlive } from '../../engine/update-restart.mjs';

// 2026-10-07 真机：另一台电脑更新后服务退出，没有守护拉起。
test('no watchdog: spawn one detached before exiting', async () => {
  const spawned = [], exits = [];
  const r = createUpdateRestart({ root: 'D:/app', alive: async () => false, delayMs: 5, execPath: 'node',
    spawn: (file, args, opts) => { spawned.push({ file, args, opts }); return { unref() {} }; }, exit: c => exits.push(c) });
  assert.deepEqual(await r(), { guarded: false });
  assert.equal(spawned.length, 1);
  assert.match(spawned[0].args[0].split(String.fromCharCode(92)).join('/'), /D:\/app\/watchdog\.cjs$/);
  assert.equal(spawned[0].opts.detached, true);
  await new Promise(x => setTimeout(x, 20));
  assert.deepEqual(exits, [0]);
});
test('watchdog present: just exit, never start a second one', async () => {
  let spawned = 0; const exits = [];
  const r = createUpdateRestart({ root: 'D:/app', alive: async () => true, delayMs: 5, spawn: () => { spawned++; }, exit: c => exits.push(c) });
  assert.deepEqual(await r(), { guarded: true });
  await new Promise(x => setTimeout(x, 20));
  assert.equal(spawned, 0); assert.deepEqual(exits, [0]);
});
test('watchdogAlive detects a listener on the singleton port', async () => {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise(x => srv.once('listening', x));
  const port = srv.address().port;
  assert.equal(await watchdogAlive({ port }), true);
  await new Promise(x => srv.close(x));
  assert.equal(await watchdogAlive({ port }), false);
});
