#!/usr/bin/env node
// 元枢离线全量安装包构建脚本（Windows x64）。
//
//   node installer/build.mjs                 # 全部步骤（已完成的步骤会跳过）
//   node installer/build.mjs --only=app,nsis # 只跑指定步骤
//   node installer/build.mjs --force=python  # 强制重做某步
//
// 步骤：node → app → python → ffmpeg → git → models → launcher → nsis
// 产物：<缓存>/stage/（展开的安装目录）与 <缓存>/元枢-离线安装包-<版本>-x64.exe
// 缓存目录默认 <仓库>/../pi-workspace/.build-cache/installer，可用 YUANSHU_BUILD_CACHE 覆盖。
// 依赖：Node ≥ 20、git、能访问 npm/pypi 镜像（只在构建机需要联网，装机时完全离线）、
//       NSIS 3（makensis.exe；默认找 Tauri 自带的 %LOCALAPPDATA%\tauri\NSIS，或设 MAKENSIS）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CACHE = process.env.YUANSHU_BUILD_CACHE || path.resolve(REPO, '..', 'pi-workspace', '.build-cache', 'installer');
const DL = path.join(CACHE, 'dl');
const STAGE = path.join(CACHE, 'stage');
const RT = path.join(STAGE, 'runtime');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'version.json'), 'utf8')).version;

const NPM_REGISTRY = process.env.YUANSHU_NPM_REGISTRY || 'https://registry.npmmirror.com';
const PIP_INDEX = process.env.YUANSHU_PIP_INDEX || 'https://mirrors.aliyun.com/pypi/simple';
const PROXY = process.env.YUANSHU_BUILD_PROXY || '';   // 例如 http://127.0.0.1:7890（只给 GitHub/python.org 下载用）

const PY_VER = '3.12.10';
const SOURCES = {
  python: { file: `python-${PY_VER}-embed-amd64.zip`, url: `https://www.python.org/ftp/python/${PY_VER}/python-${PY_VER}-embed-amd64.zip` },
  getpip: { file: 'get-pip.py', url: 'https://bootstrap.pypa.io/get-pip.py' },
  ffmpeg: { file: 'ffmpeg-shared.zip', url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip' },
  git: { file: 'PortableGit-2.56.0.2-64-bit.7z.exe', url: 'https://registry.npmmirror.com/-/binary/git-for-windows/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe' },
  u2net: { file: 'u2net.onnx', url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx' },
};
// 引擎版本钉死，保证每次构建可复现
const NPM_GLOBALS = ['@earendil-works/pi-coding-agent@0.87.1', '@deepseek-ai/dsh@0.1.5-rc.2'];
const PIP_PACKAGES = ['python-pptx', 'python-docx', 'openpyxl', 'xlrd', 'pandas', 'numpy', 'pillow', 'pymupdf', 'requests', 'edge-tts', 'rembg[cpu]==2.0.84'];

// 进安装包的仓库文件：只取 git 已跟踪文件（天然排除密钥/令牌/日志/备份/本机数据），再剔除开发用目录
const EXCLUDE_PREFIX = ['tests/', 'bench/', 'android/', 'app/', 'docs/', 'output/', 'installer/', '.superpowers/', '.impeccable/', 'public-backup-'];
const EXCLUDE_FILE = /^(AGENTS\.md|CHANGES-.*|capacitor\.config\.ts|cross-review\.py|server-new\.mjs|install(-all|-lite|-demo)?\.ps1|autostart\.ps1|.*\.cmd|\.gitignore)$/;
const keepRepoFile = (f) => {
  if (f.startsWith('frontend/')) return f.startsWith('frontend/dist/');
  if (EXCLUDE_PREFIX.some((p) => f.startsWith(p))) return false;
  if (!f.includes('/') && EXCLUDE_FILE.test(f)) return false;
  return true;
};

const args = process.argv.slice(2);
const opt = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1]?.split(',').filter(Boolean) || [];
const ONLY = opt('only');
const FORCE = opt('force');

const log = (...m) => console.log(`[build ${new Date().toTimeString().slice(0, 8)}]`, ...m);
const run = (cmd, argv, o = {}) => execFileSync(cmd, argv, { stdio: 'inherit', windowsHide: true, ...o });
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const marker = (step) => path.join(CACHE, `.done-${step}`);

function download(key) {
  const { file, url } = SOURCES[key];
  const dst = path.join(DL, file);
  if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return dst;
  mk(DL);
  log('下载', url);
  const viaProxy = PROXY && !url.includes('npmmirror.com');
  run('curl', ['-fL', '--retry', '3', ...(viaProxy ? ['-x', PROXY] : []), '-o', dst + '.part', url]);
  fs.renameSync(dst + '.part', dst);
  return dst;
}

function unzip(zip, dest) {
  mk(dest);
  run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`]);
}

function copyTree(src, dst, filter = () => true) {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (!filter(s, ent)) continue;
    if (ent.isDirectory()) { mk(d); copyTree(s, d, filter); }
    else { mk(path.dirname(d)); fs.copyFileSync(s, d); }
  }
}

const NODE = path.join(RT, 'node', 'node.exe');
const NPM_CLI = path.join(RT, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');

const STEPS = {
  // 1. 元枢源码 + 生产依赖
  app() {
    const dst = path.join(STAGE, 'app');
    rm(dst); mk(dst);
    const files = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\0').filter(Boolean).filter(keepRepoFile);
    let n = 0;
    for (const f of files) {
      const s = path.join(REPO, f);
      if (!fs.existsSync(s)) continue;
      mk(path.dirname(path.join(dst, f)));
      fs.copyFileSync(s, path.join(dst, f));
      n++;
    }
    log('源码文件', n);
    fs.writeFileSync(path.join(CACHE, 'app-manifest.json'), JSON.stringify(files));
    if (!fs.existsSync(NODE)) throw new Error('先跑 node 步骤');
    run(NODE, [NPM_CLI, 'ci', '--omit=dev', '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`], { cwd: dst });
    // mcp-server 是独立包，自带依赖
    if (fs.existsSync(path.join(dst, 'mcp-server', 'package-lock.json'))) {
      run(NODE, [NPM_CLI, 'ci', '--omit=dev', '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`], { cwd: path.join(dst, 'mcp-server') });
    }
  },

  // 2. Node 运行时（与构建机同版本）+ npm + pi/dsh 引擎
  node() {
    const dst = path.join(RT, 'node');
    rm(dst); mk(dst);
    const nodeDir = path.dirname(process.execPath);
    fs.copyFileSync(process.execPath, NODE);
    for (const f of ['npm', 'npm.cmd', 'npx', 'npx.cmd']) if (fs.existsSync(path.join(nodeDir, f))) fs.copyFileSync(path.join(nodeDir, f), path.join(dst, f));
    copyTree(path.join(nodeDir, 'node_modules', 'npm'), path.join(dst, 'node_modules', 'npm'));
    // config.mjs 会在 node.exe 同级 node_modules 里找 pi 引擎；--prefix 指到这里，npm 会把包和 .cmd 垫片放进来
    run(NODE, [NPM_CLI, 'i', '-g', `--prefix=${dst}`, '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`, ...NPM_GLOBALS]);
  },

  // 3. Python 嵌入版 + 常用库
  python() {
    const dst = path.join(RT, 'python');
    rm(dst);
    unzip(download('python'), dst);
    const pth = fs.readdirSync(dst).find((f) => /^python\d+\._pth$/.test(f));
    fs.writeFileSync(path.join(dst, pth), fs.readFileSync(path.join(dst, pth), 'utf8').replace(/^#\s*import site/m, 'import site') + '\nLib\\site-packages\n');
    const py = path.join(dst, 'python.exe');
    const pipEnv = { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONUTF8: '1' };
    run(py, [download('getpip'), '--no-warn-script-location', '-i', PIP_INDEX], { env: pipEnv });
    run(py, ['-m', 'pip', 'install', '--no-warn-script-location', '--no-cache-dir', '-i', PIP_INDEX, ...PIP_PACKAGES], { env: pipEnv });
    // 字节码缓存与测试目录不进包
    const prune = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (ent.name === '__pycache__') rm(p); else prune(p); }
      }
    };
    prune(path.join(dst, 'Lib'));
  },

  // 4. ffmpeg / ffprobe（共享库版：两个 exe 共用 DLL，比静态版小一半以上）
  ffmpeg() {
    const tmp = path.join(CACHE, 'ffmpeg-x');
    rm(tmp);
    unzip(download('ffmpeg'), tmp);
    const top = path.join(tmp, fs.readdirSync(tmp)[0], 'bin');
    const dst = path.join(RT, 'ffmpeg', 'bin');
    rm(path.dirname(dst)); mk(dst);
    for (const f of fs.readdirSync(top)) if (f !== 'ffplay.exe') fs.copyFileSync(path.join(top, f), path.join(dst, f));
    rm(tmp);
  },

  // 5. PortableGit（git + bash，元枢的 bash 工具用它）
  git() {
    const dst = path.join(RT, 'git');
    rm(dst); mk(dst);
    run(download('git'), ['-y', `-o${dst}`]);
    for (const rel of ['usr/share/doc', 'usr/share/man', 'usr/share/info', 'mingw64/share/doc', 'mingw64/share/gtk-doc', 'mingw64/doc']) rm(path.join(dst, rel));
  },

  // 6. 抠图模型（rembg 通过 U2NET_HOME 找它）
  models() {
    const dst = path.join(RT, 'models');
    mk(dst);
    const local = path.join(REPO, 'models', 'u2net.onnx');
    fs.copyFileSync(fs.existsSync(local) ? local : download('u2net'), path.join(dst, 'u2net.onnx'));
  },

  // 7. 启动器、工作区模板、图标（编码转换：VBS 要 UTF-16LE，PS1 要 UTF-8 BOM）
  launcher() {
    const dst = path.join(STAGE, 'launcher');
    rm(dst); mk(dst);
    for (const f of fs.readdirSync(path.join(HERE, 'launcher'))) {
      const text = fs.readFileSync(path.join(HERE, 'launcher', f), 'utf8').replace(/^\uFEFF/, '');
      const crlf = text.replace(/\r?\n/g, '\r\n');
      if (f.endsWith('.vbs')) fs.writeFileSync(path.join(dst, f), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(crlf, 'utf16le')]));
      else if (f.endsWith('.ps1')) fs.writeFileSync(path.join(dst, f), '\uFEFF' + crlf, 'utf8');
      else fs.writeFileSync(path.join(dst, f), text, 'utf8');
    }
    fs.copyFileSync(path.join(REPO, 'app', 'src-tauri', 'icons', 'icon.ico'), path.join(dst, 'yuanshu.ico'));
    rm(path.join(STAGE, 'template'));
    copyTree(path.join(HERE, 'template'), path.join(STAGE, 'template'));
    fs.copyFileSync(path.join(HERE, 'template', 'workspace', '开始使用.md'), path.join(STAGE, '开始使用.md'));
  },

  // 8. NSIS 打包
  nsis() {
    const makensis = process.env.MAKENSIS || path.join(process.env.LOCALAPPDATA || '', 'tauri', 'NSIS', 'makensis.exe');
    if (!fs.existsSync(makensis)) throw new Error('找不到 makensis.exe，请安装 NSIS 3 或设置 MAKENSIS');
    // 冲烟测试跑过的 stage 会多出令牌/日志/崩溃记录：不在源码清单里的一律不进包（node_modules 除外）
    const manifest = new Set(JSON.parse(fs.readFileSync(path.join(CACHE, 'app-manifest.json'), 'utf8')));
    const appDir = path.join(STAGE, 'app');
    const stray = [];
    const scan = (rel) => {
      for (const ent of fs.readdirSync(path.join(appDir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) { if (ent.name !== 'node_modules') scan(r); continue; }
        if (!manifest.has(r)) stray.push(r);
      }
    };
    scan('');
    for (const r of stray) fs.rmSync(path.join(appDir, r), { force: true });
    if (stray.length) log('清理非源码文件', stray.length, stray.slice(0, 8).join(', '));
    const out = path.join(CACHE, `元枢-离线安装包-${VERSION}-x64.exe`);
    run(makensis, ['-V2', '-INPUTCHARSET', 'UTF8', `-DSTAGE=${STAGE}`, `-DVERSION=${VERSION}`, `-DOUTFILE=${out}`, path.join(HERE, 'yuanshu.nsi')]);
    log('安装包', out, (fs.statSync(out).size / 1048576).toFixed(1) + 'MB');
  },
};

mk(CACHE);
const order = ['node', 'app', 'python', 'ffmpeg', 'git', 'models', 'launcher', 'nsis'];
for (const step of order) {
  if (ONLY.length && !ONLY.includes(step)) continue;
  const always = step === 'launcher' || step === 'nsis';
  if (!always && !FORCE.includes(step) && !ONLY.includes(step) && fs.existsSync(marker(step))) { log('跳过（已完成）', step); continue; }
  log('==>', step);
  const t = Date.now();
  STEPS[step]();
  fs.writeFileSync(marker(step), new Date().toISOString());
  log('完成', step, Math.round((Date.now() - t) / 1000) + 's');
}
