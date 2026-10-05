// 前端产物清理：只删所有入口都不可达的指纹分块；部署流水线必须 build → prune → sync。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pruneDist } from '../../scripts/prune-dist.mjs';

async function makeDist() {
  const dist = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-prune-'));
  const a = path.join(dist, 'assets');
  await fs.mkdir(a);
  await fs.writeFile(path.join(dist, 'index.html'), '<script src="./assets/index-AAAAAAAA.js"></script><link href="./assets/index-CCCCCCCC.css">');
  await fs.writeFile(path.join(a, 'index-AAAAAAAA.js'), 'import("./Lazy-BBBBBBBB.js")');
  await fs.writeFile(path.join(a, 'Lazy-BBBBBBBB.js'), 'lazy');
  await fs.writeFile(path.join(a, 'index-CCCCCCCC.css'), 'body{}');
  await fs.writeFile(path.join(a, 'index-OLDOLD11.js'), 'import("./Lazy-OLDOLD22.js")');
  await fs.writeFile(path.join(a, 'Lazy-OLDOLD22.js'), 'old lazy');
  await fs.writeFile(path.join(a, 'Stale-ZZZZZZZZ.js'), 'stale');
  await fs.writeFile(path.join(a, 'favicon.svg'), '<svg/>');
  return dist;
}

test('pruneDist 预览：列出不可达指纹分块，不删文件', async () => {
  const dist = await makeDist();
  try {
    const r = pruneDist({ distDir: dist, extraEntries: [] });
    assert.deepEqual(r.orphans.sort(), ['Lazy-OLDOLD22.js', 'Stale-ZZZZZZZZ.js', 'index-OLDOLD11.js']);
    assert.equal(r.applied, false);
    assert.ok(await fs.stat(path.join(dist, 'assets', 'Stale-ZZZZZZZZ.js')));
  } finally { await fs.rm(dist, { recursive: true, force: true }); }
});

test('pruneDist 保留最近发布入口的整条懒加载链，非指纹文件不动', async () => {
  const dist = await makeDist();
  try {
    const r = pruneDist({ distDir: dist, apply: true, extraEntries: [{ ref: 'prev', html: '<script src="./assets/index-OLDOLD11.js">' }] });
    assert.deepEqual(r.orphans, ['Stale-ZZZZZZZZ.js']);
    const left = (await fs.readdir(path.join(dist, 'assets'))).sort();
    assert.deepEqual(left, ['Lazy-BBBBBBBB.js', 'Lazy-OLDOLD22.js', 'favicon.svg', 'index-AAAAAAAA.js', 'index-CCCCCCCC.css', 'index-OLDOLD11.js']);
  } finally { await fs.rm(dist, { recursive: true, force: true }); }
});

test('pruneDist 缺 assets 目录直接报错', async () => {
  const dist = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanshu-prune-empty-'));
  try { assert.throws(() => pruneDist({ distDir: dist, extraEntries: [] }), /找不到/); }
  finally { await fs.rm(dist, { recursive: true, force: true }); }
});

test('deploy:frontend 顺序固定为 build → prune --apply → sync，移动端构建复用它', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const deploy = pkg.scripts['deploy:frontend'];
  assert.ok(deploy, 'deploy:frontend 必须存在');
  const iBuild = deploy.indexOf('build:frontend'), iPrune = deploy.indexOf('prune-dist.mjs --apply'), iSync = deploy.indexOf('sync:frontend');
  assert.ok(iBuild >= 0 && iPrune > iBuild && iSync > iPrune, deploy);
  assert.match(pkg.scripts['build:mobile:web'], /deploy:frontend/);
});
