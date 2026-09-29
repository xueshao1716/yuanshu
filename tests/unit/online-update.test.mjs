import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const mod = await import('../../engine/online-update.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const root = path.resolve(import.meta.dirname, '../..');

function fixture({ fail = '', platform = 'linux', pause } = {}) {
  assert.equal(typeof mod.createUpdateHandler, 'function');
  const calls = [], events = [];
  const handler = mod.createUpdateHandler({ root, platform,
    execute: async (file, args, options) => {
      const command = args.join(' ');
      calls.push({ file, args, options });
      events.push(command);
      if (pause) await pause(command);
      return command.includes(fail) && fail ? { ok: false, err: 'injected failure' } : { ok: true, out: '' };
    },
    scheduleRestart: () => events.push('restart'),
  });
  const response = () => ({
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); events.push('response'); },
  });
  return { handler, calls, events, response };
}

test('update installs root and frontend dependencies before success and restart', async () => {
  const f = fixture(), res = f.response();
  await f.handler(res, {});
  assert.equal(res.status, 200);
  const installs = f.calls.filter(c => c.file === 'npm');
  assert.deepEqual(installs.map(c => c.options.cwd), [root, path.join(root, 'frontend')]);
  for (const call of installs) {
    assert.deepEqual(call.args, ['install', '--no-save', '--no-audit', '--no-fund', '--include=dev']);
    assert.equal(call.options.windowsHide, true);
    assert.ok(call.options.timeout >= 180000);
  }
  assert.ok(f.events[0].includes('fetch origin'));
  assert.ok(f.events[1].includes('pull --ff-only origin main'));
  assert.deepEqual(f.events.slice(-2), ['response', 'restart']);
});

for (const failedStage of ['fetch', 'pull', 'root', 'frontend', 'engine']) {
  test(`${failedStage} failure never reports success or schedules restart`, async () => {
    const f = fixture({ fail: failedStage === 'engine' ? '-g' : ['fetch', 'pull'].includes(failedStage) ? failedStage : '' });
    let installs = 0;
    const handler = ['root', 'frontend'].includes(failedStage) ? mod.createUpdateHandler({ root,
      execute: async (file, args) => {
        f.calls.push({ file, args });
        if (file !== 'git' && ++installs === (failedStage === 'root' ? 1 : 2)) return { ok: false, err: 'injected failure' };
        return { ok: true, out: '' };
      }, platform: 'linux', scheduleRestart: () => f.events.push('restart'),
    }) : f.handler;
    const res = f.response();
    await handler(res, { engine: failedStage === 'engine' });
    assert.equal(res.status, failedStage === 'pull' ? 409 : 500);
    assert.notEqual(res.body.ok, true);
    assert.equal(f.events.includes('restart'), false);
    assert.match(res.body.error, /injected failure/);
    if (['root', 'frontend'].includes(failedStage)) assert.match(res.body.error, /未重启/);
  });
}

test('Windows npm commands use a hidden command interpreter, not execFile npm.cmd', async () => {
  const f = fixture({ platform: 'win32' }), res = f.response();
  await f.handler(res, { engine: true });
  assert.equal(res.status, 200);
  const npmCalls = f.calls.filter(c => c.file !== 'git');
  assert.equal(npmCalls.length, 3);
  for (const call of npmCalls) {
    assert.equal(call.file, 'cmd.exe');
    assert.deepEqual(call.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(call.args[3], /^npm /);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.shell, undefined);
  }
});

test('a concurrent update and a second update awaiting restart are rejected', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ pause: async command => { if (command.includes('fetch')) { entered(); await gate; } } });
  const first = f.handler(f.response(), {});
  await started;
  const second = f.response(); await f.handler(second, {});
  assert.equal(second.status, 409);
  release(); await first;
  const third = f.response(); await f.handler(third, {});
  assert.equal(third.status, 409);
});

test('failed updates release the busy guard for a retry', async () => {
  const f = fixture({ fail: 'fetch' });
  for (let i = 0; i < 2; i++) {
    const res = f.response(); await f.handler(res, {});
    assert.equal(res.status, 500);
  }
});

test('self-heal wires the dependency-aware handler to the actual repository root', () => {
  const source = fs.readFileSync(path.join(root, 'engine/self-heal.mjs'), 'utf8');
  assert.ok(source.includes('createUpdateHandler({ root: repoRoot() })'));
});

test('command exceptions report failure, release the guard and never restart', async () => {
  const events = [];
  const handler = mod.createUpdateHandler({ root,
    execute: async () => { throw Error('spawn failed'); },
    scheduleRestart: () => events.push('restart'),
  });
  for (let i = 0; i < 2; i++) {
    const res = { writeHead(code) { this.status = code; }, end(text) { this.body = JSON.parse(text); } };
    await handler(res, {});
    assert.equal(res.status, 500);
    assert.match(res.body.error, /spawn failed/);
  }
  assert.deepEqual(events, []);
});

test('real git and npm update an offline temporary checkout without changing lockfiles', { timeout: 60000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-update-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const checkout = path.join(temp, 'checkout with spaces'), origin = path.join(temp, 'origin.git');
  const git = args => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: 'pipe' });
  git(['init', '--bare', origin]);
  git(['init', '-b', 'main', checkout]);
  const originals = new Map();
  for (const [name, dir] of [['yuanshu-fixture', checkout], ['yuanshu-frontend-fixture', path.join(checkout, 'frontend')]]) {
    fs.mkdirSync(dir, { recursive: true });
    const pkg = { name, version: '1.0.0', private: true };
    const lock = { ...pkg, lockfileVersion: 3, requires: true, packages: { '': pkg } };
    for (const [file, value] of [['package.json', pkg], ['package-lock.json', lock]]) {
      const target = path.join(dir, file), content = JSON.stringify(value, null, 2) + '\n';
      fs.writeFileSync(target, content); originals.set(target, content);
    }
    fs.writeFileSync(path.join(dir, '.npmrc'), 'offline=true\nupdate-notifier=false\n');
  }
  git(['-C', checkout, 'add', '.']);
  git(['-C', checkout, '-c', 'user.name=Yuanshu test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  git(['-C', checkout, 'remote', 'add', 'origin', origin]);
  git(['-C', checkout, 'push', '-u', 'origin', 'main']);
  let restarted = false;
  const handler = mod.createUpdateHandler({ root: checkout, scheduleRestart: () => { restarted = true; } });
  const res = { writeHead(code) { this.status = code; }, end(text) { this.body = JSON.parse(text); } };
  await handler(res, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(restarted, true);
  for (const [file, content] of originals) assert.equal(fs.readFileSync(file, 'utf8'), content, file);
});
