import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { loadTeamRuntimeConfig } from '../../scripts/team-runtime-config.mjs';
import { defaultWorkspace } from '../../engine/workspace-default.mjs';

const repoRoot = path.resolve('tmp/config-fixture-repo');
const load = env => loadTeamRuntimeConfig({ env, repoRoot, readTokenFile: () => 'fixture-token' });
test('team config uses injected workspace, port and token', () => {
  const cfg = load({ YUANSHU_CWD: repoRoot, PI_WEB_CWD: 'ignored', YUANSHU_PORT: '9876', YUANSHU_TOKEN: 'new', PI_WEB_TOKEN: 'old' });
  assert.equal(cfg.wsRoot, repoRoot);
  assert.equal(cfg.teamRoot, path.join(repoRoot, '工程', '多AI角色扮演系统'));
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:9876');
  assert.equal(cfg.token, 'new');
  assert.equal(load({ PI_WEB_CWD: repoRoot, PI_WEB_PORT: '8888', PI_WEB_TOKEN: 'old' }).token, 'old');
});
test('team config standalone fallback follows the deployed workspace', () => {
  const cfg = load({ YUANSHU_TEAM_BASE_URL: 'http://127.0.0.1:9123' });
  if (process.platform === 'win32' && fs.existsSync('D:\\pi-workspace')) assert.equal(cfg.wsRoot, 'D:\\pi-workspace');
});
test('workspace precedence is shared and deterministic across drives', () => {
  const seen = [];
  const workspace = defaultWorkspace({ platform: 'win32', home: 'C:\\Users\\fixture', isDirectory: candidate => { seen.push(candidate); return candidate === 'C:\\pi-workspace'; } });
  assert.equal(workspace, 'C:\\pi-workspace');
  assert.deepEqual(seen, ['D:\\pi-workspace', 'E:\\pi-workspace', 'C:\\pi-workspace']);
  assert.equal(defaultWorkspace({ platform: 'linux', home: '/home/fixture', isDirectory: () => false }), path.join('/home/fixture', 'pi-workspace'));
});
test('token fallback is relative to repository and never generated', () => {
  let requested;
  const cfg = loadTeamRuntimeConfig({ env: {}, repoRoot, readTokenFile: file => { requested = file; return ' fixture '; } });
  assert.equal(requested, path.join(repoRoot, '.token'));
  assert.equal(cfg.token, 'fixture');
  assert.throws(() => load({ YUANSHU_TOKEN: '  ' }), /凭据/);
});
test('credential-bearing requests are restricted to exact loopback origins', () => {
  for (const url of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://a:b@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?x=1', 'http://127.0.0.1#x']) {
    assert.throws(() => load({ YUANSHU_TEAM_BASE_URL: url }), /本机/);
  }
  assert.equal(load({ YUANSHU_TEAM_BASE_URL: 'http://127.0.0.1:9123/' }).baseUrl, 'http://127.0.0.1:9123');
});
test('runner has no external spec or fixed D drive dependency', () => {
  const src = fs.readFileSync(new URL('../../scripts/team-run-live.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('loadTeamRuntimeConfig('));
  assert.equal(src.includes("'D:"), false);
  assert.equal(src.includes("'spec', 'roles.json'"), false);
  assert.equal(src.includes("'spec', 'checklists'"), false);
  assert.ok(src.includes('reviewAtomicWrite('));
});
