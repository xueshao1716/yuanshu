// Fixed local checks with redirected application state; this is not an OS sandbox.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createReviewVerification } from '../engine/review-verification.mjs';
import { verificationEnvironment, verificationSteps, skillInventory, runVerificationChecks } from './verification-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = createReviewVerification({ root });
const logDir = path.join(root, 'tmp');
fs.mkdirSync(logDir, { recursive: true });
const lock = path.join(logDir, 'review-verification.lock');
let lockFd;
try { lockFd = fs.openSync(lock, 'wx'); }
catch { console.error('已有验证锁；确认没有验证进程后再检查 tmp/review-verification.lock'); process.exit(1); }
let temp;
try {
  fs.writeFileSync(lockFd, String(process.pid));
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-verification-'));
  const inventory = skillInventory(root);
  fs.writeFileSync(path.join(logDir, 'verification-skills.json'), JSON.stringify(inventory, null, 2));
  console.log(`技能：仓库 ${inventory.tracked.length}，本机附加 ${inventory.local.length}，缺入口 ${inventory.missing.length}；全部参与检查`);
  process.exitCode = runVerificationChecks({ steps: verificationSteps(root, logDir), env: verificationEnvironment(temp), store, digest: store.fingerprint(), logDir });
} catch (error) {
  store.save({ digest: store.fingerprint(), checks: [{ name: 'setup', state: 'failed', error: String(error.message) }] });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.closeSync(lockFd);
  fs.unlinkSync(lock);
  // Retain isolated outputs for failure diagnosis; never touch production artifacts.
  if (temp) console.log(`隔离测试目录：${temp}`);
}
