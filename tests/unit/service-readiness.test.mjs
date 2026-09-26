import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const file = new URL('../../lib/service-readiness.cjs', import.meta.url);
const load = () => { assert.ok(fs.existsSync(file), 'service readiness module must exist'); return require(file.pathname.replace(/^\/([A-Z]:)/i, '$1')); };

test('health requires 200 and JSON ok true, not just an open port', async t => {
  const { serviceHealthy } = load();
  let status = 200, body = '{"ok":true}';
  const server = http.createServer((req, res) => { assert.equal(req.url, '/api/health'); res.writeHead(status); res.end(body); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  assert.equal(await serviceHealthy(port), true);
  for (const value of ['html', '{"ok":false}', '{}']) { body = value; assert.equal(await serviceHealthy(port), false); }
  status = 503; body = '{"ok":true}'; assert.equal(await serviceHealthy(port), false);
});

test('health has a deadline even when a socket never sends headers', async t => {
  const { serviceHealthy } = load();
  const server = http.createServer(() => {});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal(await serviceHealthy(server.address().port, 40), false);
});

test('startup gate coalesces overlapping callers and releases after failure', async () => {
  const { singleFlight } = load();
  let calls = 0, release;
  const action = singleFlight(async () => { calls++; await new Promise(r => { release = r; }); return 'done'; });
  const a = action(), b = action(); await Promise.resolve();
  assert.equal(calls, 1); release(); assert.deepEqual(await Promise.all([a, b]), ['done', 'done']);
  const failing = singleFlight(async () => { throw Error('failure'); });
  await assert.rejects(failing(), /failure/); await assert.rejects(failing(), /failure/);
});

test('watchdog never kills port owners; scheduled retry has no one-day expiry', () => {
  const watchdog = fs.readFileSync(new URL('../../watchdog.cjs', import.meta.url), 'utf8');
  assert.ok(!watchdog.includes('taskkill'), 'automatic recovery must not kill another healthy instance');
  assert.ok(watchdog.includes('serviceHealthy'));
  const install = fs.readFileSync(new URL('../../autostart.ps1', import.meta.url), 'utf8');
  assert.ok(!install.includes('-RepetitionDuration'));
  assert.ok(install.includes('-MultipleInstances IgnoreNew'));
  assert.ok(install.includes('Get-Command node'));
});

test('autostart migration cannot remove unrelated products tasks', () => {
  const install = fs.readFileSync(new URL('../../autostart.ps1', import.meta.url), 'utf8');
  const names = install.split('\n').find(line => line.startsWith('$legacyNames'));
  assert.equal(names.trim(), "$legacyNames = @('pi-web-watchdog', 'piweb-server')");
});

test('autostart selects a single executable when multiple Node installations are on PATH', () => {
  const install = fs.readFileSync(new URL('../../autostart.ps1', import.meta.url), 'utf8');
  const assignment = install.split('\n').find(line => line.startsWith('$node ='));
  assert.ok(assignment.includes('Select-Object -First 1'));
});
