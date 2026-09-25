// Shared implementation for the local and CI verification entrypoint.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

export function verificationEnvironment(temp, parent = process.env) {
  const allowed = /^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|home|homedrive|homepath|appdata|localappdata|programfiles|programfiles\(x86\)|programdata|systemdrive|lang|lc_all|number_of_processors|processor_architecture)$/i;
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) => allowed.test(key)));
  const workspace = path.join(temp, 'workspace');
  const agent = path.join(temp, 'agent');
  return { ...env, YUANSHU_CWD: workspace, PI_WEB_CWD: workspace, PI_WORKSPACE: workspace,
    YUANSHU_AGENT_DIR: agent, PI_WEB_AGENT_DIR: agent, YUANSHU_TOKEN: 'verification-only-not-a-service-token',
    YUANSHU_VERIFICATION_ROOT: temp, NO_COLOR: '1' };
}

export function verificationSteps(root, logDir) {
  const tests = fs.readdirSync(path.join(root, 'tests/unit')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `tests/unit/${f}`);
  return [
    { name: 'unit', cwd: root, args: ['--import', pathToFileURL(path.join(root, 'scripts/verification-preload.mjs')).href, '--test', '--test-concurrency=1', ...tests] },
    { name: 'types', cwd: path.join(root, 'frontend'), args: ['node_modules/typescript/bin/tsc', '--noEmit'] },
    { name: 'build', cwd: path.join(root, 'frontend'), args: ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(logDir, 'verification-dist')] },
  ];
}

export function skillInventory(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'skills'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0');
  const tracked = new Set(files.filter(f => /^skills\/[^/]+\/SKILL\.md$/.test(f)).map(f => f.split('/')[1]));
  const inventory = { tracked: [], local: [], missing: [] };
  for (const entry of fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!fs.existsSync(path.join(root, 'skills', name, 'SKILL.md'))) inventory.missing.push(name);
    else inventory[tracked.has(name) ? 'tracked' : 'local'].push(name);
  }
  return inventory;
}

export function runVerificationChecks({ steps, env, store, digest, logDir, spawn = spawnSync }) {
  const checks = [];
  store.save({ digest, state: 'running', checks });
  for (const { name, cwd, args } of steps) {
    const log = path.join(logDir, `verification-${name}.log`);
    const fd = fs.openSync(log, 'w');
    const started = Date.now();
    let result;
    try {
      try { result = spawn(process.execPath, args, { cwd, env, windowsHide: true, timeout: 15 * 60_000, stdio: ['ignore', fd, fd] }); }
      catch (error) { result = { status: null, error }; }
      if (result.error) fs.writeSync(fd, `\nExecution error: ${result.error.code || 'UNKNOWN'} ${result.error.message}\n`);
    } finally { fs.closeSync(fd); }
    const state = result.status === 0 && !result.error ? 'passed' : 'failed';
    checks.push({ name, state, exitCode: result.status, signal: result.signal || null, errorCode: result.error?.code || null, durationMs: Date.now() - started, log: `tmp/verification-${name}.log` });
    store.save({ digest, state: 'running', checks });
    console.log(`${name}: ${state} (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  store.save({ digest, checks });
  return store.read().state === 'passed' ? 0 : 1;
}
