import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
async function controller() {
  assert.ok(fs.existsSync(new URL('../../app/dist/startup.mjs', import.meta.url)), 'offline startup controller must be bundled');
  return (await import('../../app/startup/startup.mjs')).createStartup;
}
test('startup invokes only fixed native actions, suppresses double clicks, enters only after health', async () => {
  const create = await controller();
  let release; const calls = [], states = [];
  const run = create({ invoke: async name => { calls.push(name); if (name === 'ensure_local_service') await new Promise(r => { release = r; }); }, render: state => states.push(state) });
  const first = run(); await run();
  assert.deepEqual(calls, ['ensure_local_service']); release(); await first;
  assert.deepEqual(calls, ['ensure_local_service', 'enter_local_workspace']);
  assert.equal(states.at(-1).phase, 'ready');
});
test('startup failure stays local, explains the issue and allows retry', async () => {
  const create = await controller(); let fail = true; const calls = [], states = [];
  const run = create({ invoke: async name => { calls.push(name); if (fail) throw 'TASK_UNAVAILABLE'; }, render: s => states.push(s) });
  await run(); assert.equal(states.at(-1).phase, 'error');
  assert.match(states.at(-1).message, /守护任务/);
  assert.deepEqual(calls, ['ensure_local_service']);
  fail = false; await run(); assert.equal(states.at(-1).phase, 'ready');
});
test('native startup permissions are local only and Android entry remains external', () => {
  const lib = read('app/src-tauri/src/lib.rs');
  assert.ok(lib.includes('WebviewUrl::App("startup.html".into())'), 'desktop needs an offline first screen');
  const cap = JSON.parse(read('app/src-tauri/capabilities/desktop-startup.json'));
  assert.equal(cap.local, true); assert.equal(cap.remote, undefined);
  assert.deepEqual(cap.platforms, ['windows']);
  assert.ok(read('app/src-tauri/build.rs').includes('.commands('), 'custom commands must participate in ACL');
  const script = read('app/src-tauri/src/ensure-service.ps1');
  assert.ok(script.includes("Start-ScheduledTask -TaskName 'yuanshu-watchdog'"));
  assert.ok(!/Stop-Process|taskkill|Invoke-Expression|RunAs/.test(script));
});
