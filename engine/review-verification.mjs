import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson } from './atomic-io.mjs';

// Evidence is local, command-produced, and bound to the input tree, never an API assertion.
export function createReviewVerification({ root }) {
  const file = path.join(root, 'tmp', 'review-verification.json');
  function fingerprint() {
    const hash = createHash('sha256');
    function visit(relative) {
      const full = path.join(root, relative);
      let st;
      try { st = fs.lstatSync(full); } catch { hash.update(`missing:${relative}\0`); return; }
      if (st.isSymbolicLink()) { hash.update(`link:${relative}:${fs.readlinkSync(full)}\0`); return; }
      if (st.isDirectory()) {
        for (const name of fs.readdirSync(full).sort()) {
          if (['node_modules', 'dist', '.git', 'coverage', 'target'].includes(name)) continue;
          visit(path.join(relative, name));
        }
      } else { hash.update(relative.replaceAll('\\', '/') + '\0'); hash.update(fs.readFileSync(full)); }
    }
    for (const name of ['engine', 'lib', 'scripts', 'tests', 'frontend/src', 'frontend/public', 'frontend/package.json', 'frontend/package-lock.json', 'frontend/tsconfig.json', 'frontend/tsconfig.app.json', 'frontend/tsconfig.node.json', 'frontend/vite.config.ts', 'frontend/index.html', 'frontend/tailwind.config.js', 'frontend/postcss.config.js', 'package.json', 'package-lock.json', 'server.mjs', 'config.mjs', 'version.json']) visit(name);
    visit('frontend/uno.config.ts');
    visit('frontend/pnpm-lock.yaml');
    visit('frontend/pnpm-workspace.yaml');
    return hash.digest('hex');
  }
  function save(record) {
    const checks = Array.isArray(record.checks) ? record.checks : [];
    const state = record.state === 'running' ? 'running' : checks.some(check => check.state === 'failed') ? 'failed'
      : ['unit', 'types', 'build'].every(name => checks.some(check => check.name === name && check.state === 'passed')) ? 'passed' : 'unknown';
    atomicWriteJson(file, { ...record, checks, state, recordedAt: new Date().toISOString() });
  }
  function read() {
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!record.digest || !Array.isArray(record.checks)) throw new Error('invalid evidence');
      const expired = record.state === 'running' && Date.now() - Date.parse(record.recordedAt) > 16 * 60_000;
      return { ...record, state: expired || record.digest !== fingerprint() ? 'stale' : record.state };
    } catch { return { state: 'unknown', checks: [] }; }
  }
  return { fingerprint, save, read };
}
