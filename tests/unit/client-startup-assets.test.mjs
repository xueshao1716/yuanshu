import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { syncFrontend } from '../../scripts/sync-frontend.mjs';

test('frontend sync restores canonical offline startup assets after cleaning stale client assets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-startup-assets-'));
  try {
    const source = path.join(root, 'web'), target = path.join(root, 'client');
    await fs.mkdir(source); await fs.mkdir(target);
    await fs.writeFile(path.join(source, 'index.html'), '<h1>Web</h1>');
    await fs.writeFile(path.join(target, 'obsolete.js'), 'stale');
    await fs.writeFile(path.join(target, 'startup.html'), 'stale startup');
    await syncFrontend({ sourceDir: source, targets: [target], startupTarget: target });
    assert.equal(await fs.readFile(path.join(target, 'index.html'), 'utf8'), '<h1>Web</h1>');
    assert.equal(await fs.stat(path.join(target, 'obsolete.js')).catch(() => null), null);
    for (const name of ['startup.html', 'startup.css', 'startup.mjs']) {
      assert.equal(await fs.readFile(path.join(target, name), 'utf8'),
        await fs.readFile(new URL(`../../app/startup/${name}`, import.meta.url), 'utf8'));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
