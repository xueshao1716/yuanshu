// Fixed local checks. No arbitrary shell/API command or access to the live workspace.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createReviewVerification } from '../engine/review-verification.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = createReviewVerification({ root });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-verification-'));
const logDir = path.join(root, 'tmp');
fs.mkdirSync(logDir, { recursive: true });
const lock = path.join(logDir, 'review-verification.lock');
let lockFd;
try { lockFd = fs.openSync(lock, 'wx'); }
catch { console.error('已有验证锁；确认没有验证进程后再检查 tmp/review-verification.lock'); process.exit(1); }
const checks = [];
const digest = store.fingerprint();
const steps = [
  ['unit', root, ['--test', '--test-concurrency=1', ...fs.readdirSync(path.join(root, 'tests/unit')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `tests/unit/${f}`)]],
  ['types', path.join(root, 'frontend'), ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['build', path.join(root, 'frontend'), ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(logDir, 'verification-dist')]],
];
try {
  fs.writeFileSync(lockFd, String(process.pid));
  store.save({ digest, state: 'running', checks });
  for (const [name, cwd, args] of steps) {
    const log = path.join(logDir, `verification-${name}.log`);
    const fd = fs.openSync(log, 'w');
    const started = Date.now();
    let result;
    try {
      result = spawnSync(process.execPath, args, { cwd, windowsHide: true, timeout: 15 * 60_000,
        env: { ...process.env, YUANSHU_CWD: temp, PI_WEB_CWD: temp, PI_WORKSPACE: temp }, stdio: ['ignore', fd, fd] });
    } finally { fs.closeSync(fd); }
    const state = result.status === 0 && !result.error ? 'passed' : 'failed';
    checks.push({ name, state, exitCode: result.status, durationMs: Date.now() - started, log: `tmp/verification-${name}.log` });
    store.save({ digest, state: 'running', checks });
    console.log(`${name}: ${state}`);
  }
  store.save({ digest, checks });
  process.exitCode = store.read().state === 'passed' ? 0 : 1;
} finally {
  fs.closeSync(lockFd);
  fs.unlinkSync(lock);
  // Retain isolated outputs for failure diagnosis; never touch production artifacts.
  console.log(`隔离测试目录：${temp}`);
}
