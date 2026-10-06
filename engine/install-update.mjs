// 安装版（离线包）的在线更新：和源码版同样从 Gitee / GitHub 拉，只是第一次要把 app/ 变成 git 仓库。
//
// 安装包里的 app/ 只有 git 已跟踪文件的一个子集（不含测试、安卓、前端源码等），没有 .git。
// 第一次更新时就地 git init，配成「稀疏 + 浅 + 按需取 blob」：只检出运行要用的文件，.git 约 26MB。
// node_modules、.token、运行数据都是未跟踪文件，reset --hard 不会动它们。
import fs from 'node:fs';
import path from 'node:path';

export const BUILD_INFO = '.yuanshu-build.json';
const NPM_MIRROR = process.env.YUANSHU_NPM_REGISTRY || 'https://registry.npmmirror.com';
// 国内装机为主，Gitee 在前；两个仓库内容一致（git push origin 双推）
export const UPDATE_SOURCES = [
  'https://gitee.com/linxinyu520xue/yuanshu.git',
  'https://github.com/xueshao1716/yuanshu.git',
];

// 进安装包 / 稀疏检出的规则。installer/build.mjs 也用它挑文件，两边必须同源，否则更新会多出或删掉文件。
export const EXCLUDE_PREFIX = ['tests/', 'bench/', 'android/', 'app/', 'docs/', 'output/', 'installer/', '.superpowers/', '.impeccable/', 'public-backup-'];
const EXCLUDE_ROOT_GLOBS = ['AGENTS.md', 'CHANGES-*', 'capacitor.config.ts', 'cross-review.py', 'server-new.mjs', 'install*.ps1', 'autostart.ps1', '*.cmd', '.gitignore'];
const EXCLUDE_FILE = /^(AGENTS\.md|CHANGES-.*|capacitor\.config\.ts|cross-review\.py|server-new\.mjs|install.*\.ps1|autostart\.ps1|.*\.cmd|\.gitignore)$/;

export function keepRepoFile(f) {
  if (f.startsWith('frontend/')) return f.startsWith('frontend/dist/');
  if (EXCLUDE_PREFIX.some((p) => f.startsWith(p))) return false;
  if (!f.includes('/') && EXCLUDE_FILE.test(f)) return false;
  return true;
}

export function sparsePatterns() {
  const dirs = EXCLUDE_PREFIX.map((p) => (p.endsWith('/') ? `!/${p}` : `!/${p}*/`));
  return ['/*', ...dirs, ...EXCLUDE_ROOT_GLOBS.map((g) => `!/${g}`), '!/frontend/', '/frontend/dist/'].join('\n') + '\n';
}

export function readBuildInfo(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, BUILD_INFO), 'utf8')); } catch { return null; }
}

export const isInstalledApp = (root) => !!readBuildInfo(root);

/**
 * 安装版更新：确保仓库 → 依次试更新源 → reset 到远端 main → 只装生产依赖。
 * git/npm 由调用方注入（和 online-update.mjs 共用执行器与超时）。
 * 返回 { ok, source? , error?, stage? }，不负责响应和重启。
 */
export async function updateInstalledApp({ root, git, npm, sources = UPDATE_SOURCES }) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    for (const args of [
      ['init', '-q'],
      ['config', 'core.sparseCheckout', 'true'],
      ['config', 'core.autocrlf', 'false'],
      ['config', 'remote.origin.url', sources[0]],
      ['config', 'remote.origin.promisor', 'true'],
      ['config', 'remote.origin.partialclonefilter', 'blob:none'],
    ]) {
      const r = await git(args);
      if (!r.ok) { fs.rmSync(path.join(root, '.git'), { recursive: true, force: true }); return { ok: false, stage: 'init', error: '初始化更新仓库失败: ' + r.err }; }
    }
    fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'info', 'sparse-checkout'), sparsePatterns());
  }
  const errors = [];
  let source = '';
  for (const url of sources) {
    // 从哪个源拿到的就把 origin 指向哪个：之后按需补 blob 也走同一个源
    await git(['config', 'remote.origin.url', url]);
    const r = await git(['fetch', '--depth=1', '--filter=blob:none', 'origin', 'main']);
    if (r.ok) { source = url; break; }
    errors.push(`${new URL(url).hostname}: ${r.err}`);
  }
  if (!source) return { ok: false, stage: 'fetch', error: '两个更新源都连不上 — ' + errors.join('；') };
  const reset = await git(['reset', '-q', '--hard', 'FETCH_HEAD']);
  if (!reset.ok) return { ok: false, stage: 'checkout', error: '检出新版本失败: ' + reset.err };
  for (const dir of [root, path.join(root, 'mcp-server')]) {
    if (!fs.existsSync(path.join(dir, 'package-lock.json'))) continue;
    // 锁文件里写的是 npmjs.org，npm 会按 --registry 换成镜像（replace-registry-host 默认行为）
    const r = await npm(['install', '--omit=dev', '--no-save', '--no-audit', '--no-fund', `--registry=${NPM_MIRROR}`], dir);
    if (!r.ok) return { ok: false, stage: 'dependencies', codeUpdated: true, error: `依赖安装失败，源码已更新但未重启，请重试: ${r.err}` };
  }
  return { ok: true, source };
}
