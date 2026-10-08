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
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keepRepoFile, BUILD_INFO } from '../engine/install-update.mjs';

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
// 基本盘：文档/表格/PPT/图片/语音。pandas、PDF、抠图、ffmpeg 是可选组件（engine/addons.mjs），装机后按需联网安装；--full 全部打进包
const PIP_CORE = ['python-pptx', 'python-docx', 'openpyxl', 'xlrd', 'pillow', 'requests', 'edge-tts'];
const PIP_FULL = [...PIP_CORE, 'pandas', 'numpy', 'pymupdf', 'rembg[cpu]==2.0.84'];

// 进安装包的仓库文件：只取 git 已跟踪文件（天然排除密钥/令牌/日志/备份/本机数据），再剔除开发用目录。
// 规则 keepRepoFile 放在 engine/install-update.mjs：装机后在线更新的稀疏检出用同一份，两边不会分叉。

const args = process.argv.slice(2);
const opt = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1]?.split(',').filter(Boolean) || [];
const ONLY = opt('only');
const FORCE = opt('force');
const FULL = args.includes('--full');

const log = (...m) => console.log(`[build ${new Date().toTimeString().slice(0, 8)}]`, ...m);
const run = (cmd, argv, o = {}) => execFileSync(cmd, argv, { stdio: 'inherit', windowsHide: true, ...o });
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
// 平台专属包（esbuild/sharp/ripgrep 等按 package.json 的 os/cpu 声明分平台发布）：只留 win32-x64
function foreignPlatform(pkgDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bad = (list, want) => {
      if (!Array.isArray(list) || !list.length) return false;
      if (list.includes('!' + want)) return true;
      const pos = list.filter((x) => !x.startsWith('!'));
      return pos.length > 0 && !pos.includes(want);
    };
    return bad(j.os, 'win32') || bad(j.cpu, 'x64');
  } catch { return false; }
}
// 运行时从不加载的类型声明/源码映射、别的平台的二进制：删掉既缩包，也给最深的路径腾出 MAX_PATH 余量
function pruneNodeModules(dir) {
  let n = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'dist-types') { rm(p); n++; continue; }
        // node-gyp-build 约定的 prebuilds/<平台-架构>
        if (path.basename(d) === 'prebuilds' && !/^win32-x64/.test(ent.name)) { rm(p); n++; continue; }
        if (/node_modules([\\/]@[^\\/]+)?$/.test(d) && foreignPlatform(p)) { rm(p); n++; continue; }
        walk(p);
      }
      else if (/\.d\.[cm]?ts$|\.map$/.test(ent.name)) { fs.rmSync(p, { force: true }); n++; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}
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
    // 装机后的「检测更新」靠它知道自己是哪个提交；第一次在线更新时据此把 app/ 变成 git 仓库
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: REPO, encoding: 'utf8' }).trim();
    if (dirty) log('⚠ 工作区有未提交改动，包里的文件可能与提交', commit.slice(0, 7), '不一致');
    fs.writeFileSync(path.join(dst, BUILD_INFO), JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2));
    fs.writeFileSync(path.join(CACHE, 'app-manifest.json'), JSON.stringify(files));
    if (!fs.existsSync(NODE)) throw new Error('先跑 node 步骤');
    run(NODE, [NPM_CLI, 'ci', '--omit=dev', '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`], { cwd: dst });
    // mcp-server 是独立包，自带依赖
    if (fs.existsSync(path.join(dst, 'mcp-server', 'package-lock.json'))) {
      run(NODE, [NPM_CLI, 'ci', '--omit=dev', '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`], { cwd: path.join(dst, 'mcp-server') });
    }
    log('裁掉类型声明/映射', pruneNodeModules(path.join(dst, 'node_modules')) + pruneNodeModules(path.join(dst, 'mcp-server', 'node_modules')));
  },

  // 2. Node 运行时（与构建机同版本）+ npm + pi/dsh 引擎
  node() {
    const dst = path.join(RT, 'node');
    rm(dst); mk(dst);
    const nodeDir = path.dirname(process.execPath);
    fs.copyFileSync(process.execPath, NODE);
    // config.mjs / dsh-tool.mjs 会在 node.exe 同级 node_modules 里找引擎。
    // 用本地安装而不是 -g：全局安装不去重，dsh 的同版本依赖会层层嵌套到 280+ 字符，超 Windows MAX_PATH，NSIS 打包失败。
    const deps = Object.fromEntries(NPM_GLOBALS.map((s) => { const i = s.lastIndexOf('@'); return [s.slice(0, i), s.slice(i + 1)]; }));
    fs.writeFileSync(path.join(dst, 'package.json'), JSON.stringify({ name: 'yuanshu-runtime', private: true, dependencies: deps }, null, 2));
    run(NODE, [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', `--registry=${NPM_REGISTRY}`], { cwd: dst });
    fs.rmSync(path.join(dst, 'package.json'), { force: true });
    // npm 自身最后拷：本地安装会把不在依赖里的包当作多余删掉
    for (const f of ['npm', 'npm.cmd', 'npx', 'npx.cmd']) if (fs.existsSync(path.join(nodeDir, f))) fs.copyFileSync(path.join(nodeDir, f), path.join(dst, f));
    copyTree(path.join(nodeDir, 'node_modules', 'npm'), path.join(dst, 'node_modules', 'npm'));
    const shim = (bin) => `@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\${bin.replace(/\//g, '\\')}" %*\r\n`;
    fs.writeFileSync(path.join(dst, 'pi.cmd'), shim('@earendil-works/pi-coding-agent/dist/bundle/cli.js'));
    fs.writeFileSync(path.join(dst, 'dsh.cmd'), shim('@deepseek-ai/dsh/lib/bin.js'));
    log('裁掉类型声明/映射', pruneNodeModules(path.join(dst, 'node_modules')));
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
    run(py, ['-m', 'pip', 'install', '--no-warn-script-location', '--no-cache-dir', '-i', PIP_INDEX, ...(FULL ? PIP_FULL : PIP_CORE)], { env: pipEnv });
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
    // 文档、vim 运行时、git-lfs 不进包（新版 PortableGit 用 ucrt64，老版用 mingw64，两套都清）
    for (const rel of ['usr/share/doc', 'usr/share/man', 'usr/share/info', 'usr/share/vim', 'mingw64/share/doc', 'mingw64/share/gtk-doc', 'mingw64/doc', 'ucrt64/share/doc', 'ucrt64/share/gtk-doc', 'ucrt64/doc']) rm(path.join(dst, rel));
    for (const exe of ['mingw64/bin/git-lfs.exe', 'ucrt64/bin/git-lfs.exe']) fs.rmSync(path.join(dst, exe), { force: true });
  },

  // 6. 抠图模型（rembg 通过 U2NET_HOME 找它）
  models() {
    const dst = path.join(RT, 'models');
    mk(dst);
    const local = path.join(REPO, 'models', 'u2net.onnx');
    fs.copyFileSync(fs.existsSync(local) ? local : download('u2net'), path.join(dst, 'u2net.onnx'));
  },

  // 7a. 桌面端（Tauri NSIS 安装包）：把 Tauri 打出的 setup.exe 放进 stage/desktop/
  // 2026-10-08 改为用 NSIS setup 而非裸 exe：裸 exe 依赖特定 DLL 版本（webauthn.dll
  // 在旧版 Windows 10 上缺少入口点），且没有 WebView2 运行时检查；NSIS setup 会自动
  // 检测并安装 WebView2，兼容性更好。元枢外层 NSIS 静默调用它完成安装。
  desktop() {
    const dst = path.join(STAGE, 'desktop');
    rm(dst); mk(dst);
    const nsisDir = path.join(CACHE, 'cargo', 'release', 'bundle', 'nsis');
    // 找最新的 setup.exe
    let srcExe = null;
    if (fs.existsSync(nsisDir)) {
      const setups = fs.readdirSync(nsisDir)
        .filter(f => f.endsWith('_x64-setup.exe'))
        .map(f => ({ f, t: fs.statSync(path.join(nsisDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (setups.length) srcExe = path.join(nsisDir, setups[0].f);
    }
    if (!srcExe) {
      // 没有缓存就触发 Tauri 构建（同时产出 NSIS setup）
      log('未找到 Tauri NSIS setup，正在构建…');
      const env = {
        ...process.env,
        CARGO_TARGET_DIR: path.join(CACHE, 'cargo'),
        CARGO_HOME: path.join(CACHE, 'cargo-home'),
      };
      run(process.execPath,
        [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          'run', 'tauri', '--', 'build', '--bundles', 'nsis', '--ci'],
        { cwd: path.join(REPO, 'app'), env });
      const setups = fs.existsSync(nsisDir)
        ? fs.readdirSync(nsisDir).filter(f => f.endsWith('_x64-setup.exe'))
            .map(f => ({ f, t: fs.statSync(path.join(nsisDir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t)
        : [];
      if (!setups.length) throw new Error(`Tauri 构建失败，找不到 NSIS setup：${nsisDir}`);
      srcExe = path.join(nsisDir, setups[0].f);
    }
    // 复制为固定名，方便 NSIS 脚本引用
    fs.copyFileSync(srcExe, path.join(dst, 'yuanshu-desktop.exe'));
    log('桌面端 NSIS setup', (fs.statSync(srcExe).size / 1048576).toFixed(1) + 'MB');
  },

  // 7b. 启动器、工作区模板、图标（编码转换：VBS 要 UTF-16LE，PS1 要 UTF-8 BOM）
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
    // 桌面快捷方式的目标：原生小启动器，不再经 wscript.exe（VBScript 在下线、常被拦，且「打开文件位置」会落到 System32）。
    // .NET Framework 4 自带 csc.exe，Win10/11 都有；源码 UTF-8，必须 /codepage:65001，否则中文提示乱码
    const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    if (!fs.existsSync(csc)) throw new Error('找不到 csc.exe（.NET Framework 4），无法编译启动器');
    run(csc, ['/nologo', '/codepage:65001', '/target:winexe', '/optimize+', `/win32icon:${path.join(dst, 'yuanshu.ico')}`,
      `/out:${path.join(dst, 'yuanshu.exe')}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', path.join(HERE, 'launcher-src', 'YuanshuLauncher.cs')]);
    rm(path.join(STAGE, 'template'));
    copyTree(path.join(HERE, 'template'), path.join(STAGE, 'template'));
    fs.copyFileSync(path.join(HERE, 'template', 'workspace', '开始使用.md'), path.join(STAGE, '开始使用.md'));
  },

  // 8. NSIS 打包
  nsis() {
    // 优先 Bin/makensis.exe 本体（Tauri 根目录那个是转发壳，多一层进程）。
    // 注意：SOLID lzma 先把 4 万多个文件读进临时文件、最后才压缩；前几分钟 CPU 很低、-V2 下没有输出是正常的，不是卡死
    const tauriNsis = path.join(process.env.LOCALAPPDATA || '', 'tauri', 'NSIS');
    const makensis = process.env.MAKENSIS || [path.join(tauriNsis, 'Bin', 'makensis.exe'), path.join(tauriNsis, 'makensis.exe')].find((p) => fs.existsSync(p)) || '';
    if (!fs.existsSync(makensis)) throw new Error('找不到 makensis.exe，请安装 NSIS 3 或设置 MAKENSIS');
    // 冲烟测试跑过的 stage 会多出令牌/日志/崩溃记录：不在源码清单里的一律不进包（node_modules 除外）
    const manifest = new Set(JSON.parse(fs.readFileSync(path.join(CACHE, 'app-manifest.json'), 'utf8')));
    const appDir = path.join(STAGE, 'app');
    const stray = [];
    const scan = (rel) => {
      for (const ent of fs.readdirSync(path.join(appDir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) { if (ent.name !== 'node_modules') scan(r); continue; }
        if (!manifest.has(r) && r !== BUILD_INFO) stray.push(r);
      }
    };
    scan('');
    for (const r of stray) fs.rmSync(path.join(appDir, r), { force: true });
    if (stray.length) log('清理非源码文件', stray.length, stray.slice(0, 8).join(', '));
    // 没有它装好的元枢检测不到更新、也没法第一次在线更新
    if (!fs.existsSync(path.join(appDir, BUILD_INFO))) throw new Error(`stage/app 缺 ${BUILD_INFO}，先跑 --force=app`);
    // 安装目录前缀最长：C:\Users\ (9) + 用户名 (Windows 上限 20) + \AppData\Local\Programs\Yuanshu\ (32) = 61；
    // 相对路径 ≤ 195 → 全路径 ≤ 256 < MAX_PATH 260。自选更深的安装目录可能超限（README 已注明）
    const MAX_REL = 195;
    const longOnes = [];
    let totalBytes = 0;
    const walk = (abs, rel) => {
      for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
        const r = rel ? `${rel}\\${ent.name}` : ent.name;
        if (r.length > MAX_REL) longOnes.push(r);
        if (ent.isDirectory()) walk(path.join(abs, ent.name), r);
        else totalBytes += fs.statSync(path.join(abs, ent.name)).size;
      }
    };
    walk(STAGE, '');
    if (longOnes.length) throw new Error(`${longOnes.length} 个路径超过 ${MAX_REL} 字符，装机会超 MAX_PATH：\n${longOnes.slice(0, 5).join('\n')}`);
    const out = path.join(CACHE, `元枢-离线安装包-${VERSION}-x64.exe`);
    // 2026-10-08 nsi 改用英文临时输出名，避免中文路径按 ANSI 解码导致 CRC 失败，构建完成后再 rename
    const outTmp = path.join(STAGE, 'yuanshu-setup-out.exe');
    if (fs.existsSync(outTmp)) fs.rmSync(outTmp);
    if (fs.existsSync(out)) fs.rmSync(out);
    // -V4 写到日志文件：终端不刷 4 万行，又能用行数看进度（读文件阶段 CPU 很低，只看 CPU 会误判卡死）
    const nsisLog = path.join(CACHE, 'makensis.log');
    log('makensis 详细日志', nsisLog, '（读文件约 5~10 分钟，压缩约 20 分钟）');
    const desktopDir = path.join(STAGE, 'desktop');
    const hasDesktop = fs.existsSync(desktopDir) && fs.readdirSync(desktopDir).some(f => f.endsWith('.exe'));
    const nsisArgs = ['-V4', `-O${nsisLog}`, '-INPUTCHARSET', 'UTF8', `-DSTAGE=${STAGE}`, `-DVERSION=${VERSION}`, `-DESTSIZE_KB=${Math.ceil(totalBytes / 1024)}`];
    if (hasDesktop) nsisArgs.push('-DHAVE_DESKTOP');
    // 2026-10-08 makensis 某些版本成功但返回非零退出码，改为检查产物是否存在
    if (fs.existsSync(outTmp)) fs.rmSync(outTmp);
    try { run(makensis, [...nsisArgs, path.join(HERE, 'yuanshu.nsi')], { stdio: ['ignore', 'inherit', 'inherit'] }); } catch (_) {}
    if (!fs.existsSync(outTmp)) {
      const tail = fs.existsSync(nsisLog) ? fs.readFileSync(nsisLog, 'utf8').split(/\r?\n/).slice(-15).join('\n') : '';
      throw new Error(`makensis 失败，产物不存在，日志末尾：\n${tail}`);
    }
    // 2026-10-08 rename 到中文名（nsi 输出用英文临时名避免 CRC 乱码）
    fs.renameSync(outTmp, out);
    // 2026-10-08 构建后 CRC 自检：两个 makensis 并发写同一产物时出过坏包，装机报 integrity check failed。
    // NSIS 的 CRC32 从偏移 512 算到数据末尾前 4 字节，末 4 字节存校验值（已用完好的包校准过）。
    const crcBad = verifyNsisCrc(out);
    if (crcBad) { fs.rmSync(out, { force: true }); throw new Error(`安装包 CRC 自检失败，已删除坏包：${crcBad}`); }
    log('安装包', out, (fs.statSync(out).size / 1048576).toFixed(1) + 'MB', 'CRC 自检通过');
  },
};

// 2026-10-08 校验 NSIS 安装包完整性，返回 null 表示通过，否则返回原因
function verifyNsisCrc(file) {
  const d = fs.readFileSync(file);
  const fh = d.indexOf(Buffer.from([0xef, 0xbe, 0xad, 0xde, ...Buffer.from('NullsoftInst')])) - 4;
  if (fh < 0) return '找不到 NSIS 头';
  const end = fh + d.readUInt32LE(fh + 24);
  if (end !== d.length) return `长度不符：头部声明 ${end}，实际 ${d.length}`;
  const stored = d.readUInt32LE(end - 4);
  const actual = zlib.crc32(d.subarray(512, end - 4)) >>> 0;
  return stored === actual ? null : `存储 ${stored.toString(16)}，实算 ${actual.toString(16)}`;
}

// 2026-10-08 构建锁：防止两个构建同时写同一个安装包（坏包事故的根因）
const LOCK = path.join(CACHE, '.build.lock');
mk(CACHE);
try {
  const fd = fs.openSync(LOCK, 'wx');
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
} catch {
  const pid = Number(fs.readFileSync(LOCK, 'utf8')) || 0;
  let alive = false;
  try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
  if (alive) { console.error(`另一个构建正在运行（pid ${pid}），退出。`); process.exit(1); }
  fs.writeFileSync(LOCK, String(process.pid));
}
process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.rmSync(LOCK); } catch {} });
const order = FULL ? ['node', 'app', 'python', 'ffmpeg', 'git', 'models', 'desktop', 'launcher', 'nsis'] : ['node', 'app', 'python', 'git', 'desktop', 'launcher', 'nsis'];
// 精简包：上一次 --full 留在 stage 里的 ffmpeg/模型要清掉，否则会被打进包
if (!FULL && (!ONLY.length || ONLY.includes('nsis'))) for (const d of ['ffmpeg', 'models']) { rm(path.join(RT, d)); fs.rmSync(marker(d), { force: true }); }
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
