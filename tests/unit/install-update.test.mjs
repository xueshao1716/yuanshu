// 安装版（离线包）在线更新：没有 .git 的 app/ 也能从 Gitee/GitHub 更新
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keepRepoFile, sparsePatterns, updateInstalledApp, readBuildInfo, BUILD_INFO, UPDATE_SOURCES } from '../../engine/install-update.mjs';
import { createUpdateHandler } from '../../engine/online-update.mjs';
import { checkUpdate } from '../../engine/system-panel.mjs';

const tmpApp = (t, info = { commit: 'a'.repeat(40) }) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-inst-upd-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  if (info) fs.writeFileSync(path.join(d, BUILD_INFO), JSON.stringify(info));
  fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
  return d;
};
const recorder = (fail = {}) => {
  const calls = [];
  const git = async (args) => { calls.push(['git', ...args]); const k = Object.keys(fail).find((x) => args.join(' ').includes(x) && fail[x]-- > 0); return k ? { ok: false, err: 'boom ' + k } : { ok: true, out: '' }; };
  const npm = async (args, cwd) => { calls.push(['npm', ...args, cwd]); return { ok: true, out: '' }; };
  return { calls, git, npm };
};

test('打包规则和稀疏检出同源：前端只留 dist，开发目录与根目录杂项都排除', () => {
  for (const f of ['server.mjs', 'engine/x.mjs', 'frontend/dist/index.html', 'public/index.html', 'package-lock.json']) assert.ok(keepRepoFile(f), f);
  for (const f of ['tests/unit/a.mjs', 'frontend/src/App.tsx', 'android/x', 'installer/build.mjs', 'AGENTS.md', 'install-all.ps1', 'run.cmd', 'public-backup-20260901/a']) assert.ok(!keepRepoFile(f), f);
  const p = sparsePatterns();
  assert.match(p, /^\/\*\n/);
  assert.ok(p.includes('!/frontend/\n/frontend/dist/\n'), '先排除 frontend 再放回 dist，顺序不能反');
  assert.ok(p.includes('!/tests/') && p.includes('!/public-backup-*/'));
});

test('第一次更新：就地 init 成稀疏浅仓库，Gitee 优先，reset 后只装生产依赖', async (t) => {
  const root = tmpApp(t), r = recorder();
  const out = await updateInstalledApp({ root, git: r.git, npm: r.npm });
  assert.equal(out.ok, true);
  assert.equal(out.source, UPDATE_SOURCES[0]);
  assert.match(UPDATE_SOURCES[0], /gitee\.com/);
  assert.ok(fs.existsSync(path.join(root, '.git', 'info', 'sparse-checkout')));
  const flat = r.calls.map((c) => c.join(' '));
  assert.ok(flat.some((c) => c.includes('core.sparseCheckout true')));
  assert.ok(flat.some((c) => c.includes('core.longpaths true')));
  assert.ok(flat.some((c) => c.includes('fetch --depth=1 --filter=blob:none origin main')));
  assert.ok(flat.some((c) => c.includes('reset -q --hard FETCH_HEAD')));
  const npm = r.calls.filter((c) => c[0] === 'npm');
  assert.equal(npm.length, 1, '没有 mcp-server 锁文件就只装根目录');
  assert.ok(npm[0].includes('--omit=dev'), '安装版不装开发依赖（没有前端源码，用不上 vite）');
});

test('Gitee 连不上回退 GitHub；两轮都失败时报清楚、不检出、origin 复位到 Gitee', async (t) => {
  const root = tmpApp(t);
  const one = recorder({ fetch: 1 });
  const ok = await updateInstalledApp({ root, git: one.git, npm: one.npm });
  assert.equal(ok.ok, true);
  assert.match(ok.source, /github\.com/);
  const both = recorder({ fetch: 4 });
  const bad = await updateInstalledApp({ root: tmpApp(t), git: both.git, npm: both.npm });
  assert.equal(bad.ok, false);
  assert.equal(bad.stage, 'fetch');
  assert.match(bad.error, /gitee\.com.*github\.com/);
  assert.ok(!both.calls.some((c) => c.includes('reset')), '没拿到新版本不能 reset');
  assert.equal(both.calls.filter((c) => c.includes('fetch')).length, 4, '两个源各试两轮');
  assert.match(both.calls.at(-1).join(' '), /remote\.origin\.url https:\/\/gitee\.com/);
  const flaky = recorder({ fetch: 3 });
  const third = await updateInstalledApp({ root: tmpApp(t), git: flaky.git, npm: flaky.npm });
  assert.equal(third.ok, true, '第二轮再试 GitHub 成功');
  assert.ok(flaky.calls.some((c) => c.join(' ').includes('http.lowSpeedTime=20')), '卡住不出数据要主动放弃，别挂满超时');
});

test('更新入口：有构建信息走安装版路径，且不做 npm -g 引擎升级', async (t) => {
  const root = tmpApp(t), r = recorder();
  const events = [];
  const handler = createUpdateHandler({ root, platform: 'linux', updateSources: ['https://gitee.com/x/y.git'],
    execute: async (file, args, o) => (file === 'git' ? r.git(args.slice(2 + 4)) : r.npm(args, o.cwd)),
    scheduleRestart: () => events.push('restart') });
  const res = { writeHead(c) { this.status = c; }, end(s) { this.body = JSON.parse(s); events.push('response'); } };
  await handler(res, { engine: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.message, /来源 gitee\.com/);
  assert.ok(!r.calls.some((c) => c.includes('-g')), '安装版引擎在 runtime/node，不能 npm -g');
  assert.ok(!r.calls.some((c) => c.includes('pull')), '安装版不走 pull --ff-only');
  assert.deepEqual(events, ['response', 'restart']);
});

test('检测更新：没有 .git 时用构建提交号，不同即落后，可点更新', async (t) => {
  const root = tmpApp(t, { commit: 'b'.repeat(40) });
  assert.equal(readBuildInfo(root).commit, 'b'.repeat(40));
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sha: 'c'.repeat(40), commit: { message: 'new', author: {} } }) });
  const noGit = () => ({ ok: false, code: 128 });
  const r = await checkUpdate(root, fs, { fetchImpl, git: noGit });
  assert.equal(r.checkable, true);
  assert.equal(r.upToDate, false);
  assert.equal(r.relation, 'behind');
  const same = await checkUpdate(root, fs, { fetchImpl: async () => ({ ok: true, json: async () => ({ sha: 'b'.repeat(40), commit: { message: 'x', author: {} } }) }), git: noGit });
  assert.equal(same.upToDate, true);
});

test('构建：nsis 步骤清理杂散文件时保留构建信息，缺了就拒绝打包', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../installer/build.mjs'), 'utf8');
  assert.ok(src.includes('r !== BUILD_INFO'), '清理规则必须放过 .yuanshu-build.json');
  assert.match(src, /existsSync\(path\.join\(appDir, BUILD_INFO\)\)\) throw/);
});
