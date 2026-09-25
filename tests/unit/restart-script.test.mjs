import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('restart wrapper returns the launcher exit code without waiting for its server descendant', { skip: process.platform !== 'win32' }, () => {
  const source = readFileSync(new URL('../../scripts/restart-pi-web.ps1', import.meta.url), 'utf8');
  const start = source.indexOf('  $elevated = Start-Process');
  const end = source.indexOf('  exit $elevated.ExitCode', start);
  assert.ok(start >= 0 && end > start, 'elevation wrapper must exist');
  // Exercise the real waiting code without requesting UAC or touching port 8787.
  const wrapper = source.slice(start, end + '  exit $elevated.ExitCode'.length)
    .replace('-Verb RunAs', '');
  const encode = text => Buffer.from(text, 'utf16le').toString('base64');
  const temp = mkdtempSync(path.join(os.tmpdir(), 'yuanshu-restart-test-'));
  const pidFile = path.join(temp, 'descendant.pid');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  // Observe process lifetime directly: cold PowerShell startup is not a deadline contract.
  const sleeper = encode('Start-Sleep -Seconds 180');
  const launcher = encode(`$child = Start-Process powershell.exe -ArgumentList '-NoProfile -EncodedCommand ${sleeper}' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath ${quote(pidFile)} -Value $child.Id; exit 7`);
  const command = `$ErrorActionPreference = 'Stop'; $args = '-NoProfile -EncodedCommand ${launcher}'; ${wrapper}`;
  // A descendant inheriting a Node pipe can hold spawnSync open after the
  // wrapper exits. A file captures diagnostics without adding a pipe EOF wait.
  const outputFile = path.join(temp, 'wrapper.log');
  const outputFd = openSync(outputFile, 'w');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encode(command)], {
      timeout: 90000, windowsHide: true, stdio: ['ignore', outputFd, outputFd],
    });
    assert.ifError(result.error);
    assert.equal(result.status, 7, readFileSync(outputFile, 'utf8') || 'launcher exit code must be preserved');
    const descendantPid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    assert.doesNotThrow(() => process.kill(descendantPid, 0), 'descendant must still be running when wrapper returns');
  } finally {
    closeSync(outputFd);
    if (existsSync(pidFile)) {
      const descendantPid = Number(readFileSync(pidFile, 'utf8'));
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        try { process.kill(descendantPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
