import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const source = fs.readFileSync(new URL('../../app/src-tauri/src/ensure-service.ps1', import.meta.url), 'utf8');
const windows = process.platform === 'win32';
function run(mocks, { timeout = false } = {}) {
  // Run the real helper, substituting only OS/network boundaries. Never touch real tasks.
  const script = `${mocks}\n${timeout ? source.replace('AddSeconds(45)', 'AddSeconds(0)') : source}`;
  return execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
}
const noNetwork = 'function Invoke-WebRequest { throw "offline" }';
const readyTask = 'function Get-ScheduledTask { [pscustomobject]@{State="Ready"} }';
test('native helper enters healthy service without touching scheduled tasks', { skip: !windows }, () => {
  assert.equal(run(`function Invoke-WebRequest { [pscustomobject]@{StatusCode=200;Content='{"ok":true}'} }
    function Get-ScheduledTask { throw 'must not read task' }
    function Start-ScheduledTask { throw 'must not start task' }`), 'READY');
});
test('native helper rejects string truthiness in health JSON', { skip: !windows }, () => {
  assert.equal(run(`function Invoke-WebRequest { [pscustomobject]@{StatusCode=200;Content='{"ok":"true"}'} }
    function Get-ScheduledTask { throw 'missing' }`), 'TASK_UNAVAILABLE');
});
test('native helper distinguishes unavailable, disabled, denied, and timeout', { skip: !windows }, () => {
  assert.equal(run(`${noNetwork}\nfunction Get-ScheduledTask { throw 'missing' }`), 'TASK_UNAVAILABLE');
  assert.equal(run(`${noNetwork}\nfunction Get-ScheduledTask { [pscustomobject]@{State='Disabled'} }`), 'TASK_DISABLED');
  assert.equal(run(`${noNetwork}\n${readyTask}\nfunction Start-ScheduledTask { throw 'denied' }`), 'TASK_START_DENIED');
  assert.equal(run(`${noNetwork}\n${readyTask}\nfunction Start-ScheduledTask { }`, { timeout: true }), 'HEALTH_TIMEOUT');
});
test('native helper waits for readiness after starting exactly the fixed task', { skip: !windows }, () => {
  assert.equal(run(`$script:started=$false
    function Invoke-WebRequest { if (-not $script:started) { throw 'offline' }; [pscustomobject]@{StatusCode=200;Content='{"ok":true}'} }
    ${readyTask}
    function Start-ScheduledTask { param($TaskName) if ($TaskName -ne 'yuanshu-watchdog') { throw 'wrong task' }; $script:started=$true }`), 'READY');
});
