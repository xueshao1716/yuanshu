#!/usr/bin/env node
// 元枢 Linux x64 离线安装包构建脚本（必须在 Linux 上运行，例如 WSL；原生依赖要在目标平台装）。
//
//   node installer/build-linux.mjs            # 全部步骤，已完成的会跳过
//   node installer/build-linux.mjs --force=app,python
//
// 产物：<缓存>/元枢-离线安装包-<版本>-linux-x64.run（自解压 shell 脚本 + tar.xz）
// 缓存目录默认 ~/.cache/yuanshu-build，可用 YUANSHU_BUILD_CACHE 覆盖。
// 包内容：app（git 已跟踪源码 + 生产依赖）、Node、pi/dsh 引擎、独立 Python + 文档库、启动器、工作区模板、安装/卸载脚本。
// 不带 git/bash：Linux 自带；在线更新需要系统装有 git。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keepRepoFile, BUILD_INFO } from '../engine/install-update.mjs';

if (process.platform !== 'linux') { console.error('请在 Linux（含 WSL）里运行：原生依赖按当前平台安装。'); process.exit(1); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CACHE = process.env.YUANSHU_BUILD_CACHE || path.join(os.homedir(), '.cache', 'yuanshu-build');
const STAGE = path.join(CACHE, 'stage', 'yuanshu-linux-x64');
const RT = path.join(STAGE, 'runtime');
const DL = path.join(CACHE, 'dl');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'version.json'), 'utf8')).version;

const NPM_REGISTRY = process.env.YUANSHU_NPM_REGISTRY || 'https://registry.npmmirror.com';
const PIP_INDEX = process.env.YUANSHU_PIP_INDEX || 'https://mirrors.aliyun.com/pypi/simple';
const NODE_VER = process.version.slice(1);
const PBS_DATE = '20261013';
const PY_FULL = '3.12.15';
const SOURCES = {
  node: { file: `node-v${NODE_VER}-linux-x64.tar.xz`, url: `https://registry.npmmirror.com/-/binary/node/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz` },
  python: { file: `cpython-${PY_FULL}-${PBS_DATE}-linux-x64.tar.gz`, url: `https://registry.npmmirror.com/-/binary/python-build-standalone/${PBS_DATE}/cpython-${PY_FULL}%2B${PBS_DATE}-x86_64-unknown-linux-gnu-install_only.tar.gz` },
};
const NPM_GLOBALS = ['@earendil-works/pi-coding-agent@0.87.1', '@deepseek-ai/dsh@0.1.5-rc.2'];
const PIP_CORE = ['python-pptx', 'python-docx', 'openpyxl', 'xlrd', 'pillow', 'requests', 'edge-tts'];

const args = process.argv.slice(2);
const FORCE = (args.find((a) => a.startsWith('--force=')) || '').split('=')[1]?.split(',') || [];
const log = (...m) => console.log(`[build-linux ${new Date().toTimeString().slice(0, 8)}]`, ...m);
const run = (cmd, argv, o = {}) => execFileSync(cmd, argv, { stdio: 'inherit', ...o });
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const marker = (s) => path.join(CACHE, `.done-${s}`);

function download(key) {
  const { file, url } = SOURCES[key];
  const dst = path.join(DL, file);
  if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return dst;
  mk(DL);
  log('下载', url);
  run('curl', ['-fL', '--retry', '3', '-o', dst + '.part', url]);
  fs.renameSync(dst + '.part', dst);
  return dst;
}

function assertFrontendVersion(appDir) {
  const dist = path.join(appDir, 'frontend', 'dist');
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const entry = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  if (!entry || !fs.existsSync(path.join(dist, entry))) throw new Error('前端入口 chunk 缺失，先跑 npm run deploy:frontend');
  if (!fs.readFileSync(path.join(dist, entry), 'utf8').includes(VERSION)) throw new Error(`前端产物不是 ${VERSION}，先跑 npm run deploy:frontend`);
  log('前端版本自检通过', VERSION, entry);
}

// 只留 linux-x64 的平台专属二进制
function foreignPlatform(pkgDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bad = (list, want) => {
      if (!Array.isArray(list) || !list.length) return false;
      if (list.includes('!' + want)) return true;
      const pos = list.filter((x) => !x.startsWith('!'));
      return pos.length > 0 && !pos.includes(want);
    };
    return bad(j.os, 'linux') || bad(j.cpu, 'x64');
  } catch { return false; }
}
function pruneNodeModules(dir) {
  let n = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (ent.name === 'dist-types') { rm(p); n++; continue; }
        if (path.basename(d) === 'prebuilds' && !/^linux-x64/.test(ent.name)) { rm(p); n++; continue; }
        if (/node_modules([\\/]@[^\\/]+)?$/.test(d) && foreignPlatform(p)) { rm(p); n++; continue; }
        walk(p);
      } else if (/\.d\.[cm]?ts$|\.map$/.test(ent.name)) { fs.rmSync(p, { force: true }); n++; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

const NODE_BIN = path.join(RT, 'node', 'bin', 'node');
const NPM_CLI = path.join(RT, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');

const STEPS = {
  node() {
    const dst = path.join(RT, 'node');
    rm(dst); mk(dst);
    run('tar', ['-xJf', download('node'), '-C', dst, '--strip-components=1']);
    // 引擎装到 node 前缀下的 lib/node_modules：config.mjs / dsh-tool.mjs 按 execPath/../lib/node_modules 找
    run(NODE_BIN, [NPM_CLI, 'install', '-g', '--prefix', dst, '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`, ...NPM_GLOBALS], { env: { ...process.env, PATH: `${path.join(dst, 'bin')}:${process.env.PATH}` } });
    // node 自带的文档、头文件、man 不需要
    for (const rel of ['include', 'share', 'CHANGELOG.md', 'README.md']) rm(path.join(dst, rel));
    log('裁掉类型声明/映射', pruneNodeModules(path.join(dst, 'lib', 'node_modules')));
  },

  app() {
    const dst = path.join(STAGE, 'app');
    rm(dst); mk(dst);
    const gitList = (a) => execFileSync('git', ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', 'ls-files', '-z', ...a], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);
    const files = [...new Set([...gitList([]), ...gitList(['--others', '--exclude-standard', '--', 'frontend/dist'])])].filter(keepRepoFile);
    let n = 0;
    for (const f of files) {
      const s = path.join(REPO, f);
      if (!fs.existsSync(s)) continue;
      mk(path.dirname(path.join(dst, f)));
      fs.copyFileSync(s, path.join(dst, f));
      n++;
    }
    log('源码文件', n);
    assertFrontendVersion(dst);
    const git = (a) => execFileSync('git', ['-c', 'safe.directory=*', ...a], { cwd: REPO, encoding: 'utf8' }).trim();
    const commit = git(['rev-parse', 'HEAD']);
    if (git(['status', '--porcelain', '--untracked-files=no'])) log('⚠ 工作区有未提交改动，包里的文件可能与提交', commit.slice(0, 7), '不一致');
    fs.writeFileSync(path.join(dst, BUILD_INFO), JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2));
    fs.writeFileSync(path.join(CACHE, 'app-manifest.json'), JSON.stringify(files));
    if (!fs.existsSync(NODE_BIN)) throw new Error('先跑 node 步骤');
    const env = { ...process.env, PATH: `${path.dirname(NODE_BIN)}:${process.env.PATH}` };
    const ci = (cwd) => run(NODE_BIN, [NPM_CLI, 'ci', '--omit=dev', '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`], { cwd, env });
    ci(dst);
    if (fs.existsSync(path.join(dst, 'mcp-server', 'package-lock.json'))) ci(path.join(dst, 'mcp-server'));
    log('裁掉类型声明/映射', pruneNodeModules(path.join(dst, 'node_modules')) + pruneNodeModules(path.join(dst, 'mcp-server', 'node_modules')));
  },

  python() {
    const dst = path.join(RT, 'python');
    rm(dst); mk(RT);
    run('tar', ['-xzf', download('python'), '-C', RT]);
    const py = path.join(dst, 'bin', 'python3');
    run(py, ['-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check', '-i', PIP_INDEX, ...PIP_CORE], { env: { ...process.env, PYTHONUTF8: '1' } });
    const prune = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isSymbolicLink() || !ent.isDirectory()) continue;
        if (ent.name === '__pycache__' || ent.name === 'test' || ent.name === 'tests') rm(p); else prune(p);
      }
    };
    prune(path.join(dst, 'lib'));
  },

  launcher() {
    const dst = path.join(STAGE, 'launcher');
    rm(dst); mk(dst);
    for (const f of ['service.cjs', 'open.cjs', 'seed-workspace.cjs']) fs.copyFileSync(path.join(HERE, 'launcher', f), path.join(dst, f));
    rm(path.join(STAGE, 'template'));
    fs.cpSync(path.join(HERE, 'template'), path.join(STAGE, 'template'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'app', 'src-tauri', 'icons', 'icon.png'), path.join(STAGE, 'yuanshu.png'));
    for (const f of ['install.sh', 'uninstall.sh']) fs.copyFileSync(path.join(HERE, 'linux', f), path.join(STAGE, f));
    fs.writeFileSync(path.join(STAGE, 'VERSION'), VERSION + '\n');
  },

};

function pack() {
  const manifest = new Set(JSON.parse(fs.readFileSync(path.join(CACHE, 'app-manifest.json'), 'utf8')));
  const appDir = path.join(STAGE, 'app');
  let stray = 0;
  const scan = (rel) => {
    for (const ent of fs.readdirSync(path.join(appDir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (ent.name !== 'node_modules') scan(r); continue; }
      if (!manifest.has(r) && r !== BUILD_INFO) { fs.rmSync(path.join(appDir, r), { force: true }); stray++; }
    }
  };
  scan('');
  if (stray) log('清理非源码文件', stray);
  if (!fs.existsSync(path.join(appDir, BUILD_INFO))) throw new Error(`stage/app 缺 ${BUILD_INFO}，先 --force=app`);
  fs.chmodSync(path.join(STAGE, 'install.sh'), 0o755);
  fs.chmodSync(path.join(STAGE, 'uninstall.sh'), 0o755);

  const tarball = path.join(CACHE, 'payload.tar.xz');
  rm(tarball);
  log('压缩（xz，几分钟）…');
  run('sh', ['-c', `tar -C "${path.dirname(STAGE)}" -cf - "${path.basename(STAGE)}" | xz -T0 -6 > "${tarball}"`]);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');

  const header = (skip) => `#!/bin/sh
# 元枢 ${VERSION} Linux x64 离线安装包（自解压）。用法：sh 本文件 [--prefix DIR] [--no-service] [--uninstall] [--purge] [--help]
set -e
SUM="${sum}"
SKIP=${skip}
case "$1" in --help|-h) echo "用法: sh $(basename "$0") [--prefix DIR] [--no-service]   安装（默认 ~/.local/share/yuanshu，不需要 root）"; echo "       sh $(basename "$0") --uninstall [--purge]   卸载（--purge 同时删除工作区）"; exit 0;; esac
command -v xz >/dev/null 2>&1 || { echo "缺少 xz（Debian/Ubuntu: sudo apt install xz-utils）"; exit 1; }
[ "$(uname -m)" = "x86_64" ] || { echo "此安装包只支持 x86_64"; exit 1; }
TMP=$(mktemp -d "\${TMPDIR:-/tmp}/yuanshu-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
echo "校验安装包完整性…"
GOT=$(tail -n +$SKIP "$0" | sha256sum | cut -d' ' -f1)
[ "$GOT" = "$SUM" ] || { echo "安装包损坏（校验不一致），请重新下载"; exit 1; }
echo "解包…"
tail -n +$SKIP "$0" | tar -xJ -C "$TMP"
sh "$TMP"/yuanshu-linux-x64/install.sh "$@"
exit $?
`;
  // SKIP = 头部行数 + 1；头部行数不随 SKIP 数字位数变化，两遍即可
  const lines = header(0).split('\n').length - 1;
  const out = path.join(CACHE, `元枢-离线安装包-${VERSION}-linux-x64.run`);
  fs.writeFileSync(out, Buffer.concat([Buffer.from(header(lines + 1)), fs.readFileSync(tarball)]));
  fs.chmodSync(out, 0o755);
  log('安装包', out, (fs.statSync(out).size / 1048576).toFixed(1) + 'MB');
}

mk(CACHE);
for (const step of ['node', 'app', 'python', 'launcher']) {
  const always = step === 'launcher';
  if (!always && !FORCE.includes(step) && fs.existsSync(marker(step))) { log('跳过（已完成）', step); continue; }
  log('==>', step);
  const t = Date.now();
  STEPS[step]();
  fs.writeFileSync(marker(step), new Date().toISOString());
  log('完成', step, Math.round((Date.now() - t) / 1000) + 's');
}
pack();
