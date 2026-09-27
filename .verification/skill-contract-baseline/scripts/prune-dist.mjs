// 清理 frontend/dist 里「开发中间构建」遗留的指纹分块。
//
// 为什么会有垃圾：vite.config.ts 里 emptyOutDir:false 是**故意的**——保留上一版指纹
// 资源，避免还开着旧 index.html 的客户端懒加载新模块时 404。代价是每次构建都会新增
// 一整套分块（约 95 个 / 9 MB），一路构建下去仓库会无限膨胀。
//
// 判据（可解释，不靠猜）：从「当前 dist/index.html」和「最近 N 个提交的 index.html」
// 出发做可达性遍历；只有**所有**这些入口都到不了的指纹分块才算中间产物。
// 也就是说：当前版本依赖的文件一个都不会删，最近发布过的版本也仍然可用。
//
// 用法：
//   node scripts/prune-dist.mjs              # 只预览，列出会删什么
//   node scripts/prune-dist.mjs --apply      # 真删
//   node scripts/prune-dist.mjs --keep 3     # 多保留最近 3 个版本的入口（默认 2）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'frontend/dist');
const ASSETS = path.join(DIST, 'assets');
// 只碰 vite 生成的指纹文件，手写资源（favicon、manifest 等）一律不动
const FINGERPRINT = /-[A-Za-z0-9_\-]{8}\.(?:js|css)$/;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const keepIndex = argv.indexOf('--keep');
const KEEP = keepIndex >= 0 ? Math.max(1, Number(argv[keepIndex + 1]) || 2) : 2;

if (!fs.existsSync(ASSETS)) {
  console.error(`找不到 ${ASSETS}，先在 frontend 里执行构建。`);
  process.exit(1);
}
const assetNames = new Set(fs.readdirSync(ASSETS));

// 从一段文本里抠出指向 assets 下真实存在的文件名
// （html 里是 assets/xxx.js，js 里是 ./xxx.js；两种前缀都剥掉）
function harvest(text) {
  const out = [];
  for (const m of String(text).matchAll(/[A-Za-z0-9_][A-Za-z0-9_.\-]*\.(?:js|css)/g)) {
    const name = m[0].replace(/^\.\//, '').replace(/^assets\//, '');
    if (assetNames.has(name)) out.push(name);
  }
  return out;
}

const reachable = new Set();
function crawl(seeds) {
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.pop();
    if (reachable.has(name) || !assetNames.has(name)) continue;
    reachable.add(name);
    queue.push(...harvest(fs.readFileSync(path.join(ASSETS, name), 'utf8')));
  }
}

crawl(harvest(fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')));
console.log('当前 dist/index.html 可达: ' + reachable.size);

// 最近 N 个改动过 index.html 的提交，它们各自的入口也要继续可用
let refs = [];
try {
  refs = execFileSync('git', ['log', `-${KEEP}`, '--format=%H', '--', 'frontend/dist/index.html'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
} catch {
  console.log('（不是 git 仓库或没有历史，只按当前 index.html 判断）');
}
for (const ref of refs) {
  let html = '';
  try { html = execFileSync('git', ['show', `${ref}:frontend/dist/index.html`], { cwd: ROOT, encoding: 'utf8' }); } catch { continue; }
  const before = reachable.size;
  crawl(harvest(html));
  console.log(`  + 保留 ${ref.slice(0, 8)} 的入口，新增可达 ${reachable.size - before} 个`);
}

const orphans = fs.readdirSync(ASSETS).filter(name => FINGERPRINT.test(name) && !reachable.has(name));
let bytes = 0;
for (const name of orphans) bytes += fs.statSync(path.join(ASSETS, name)).size;

console.log(`\n可达分块 ${reachable.size} 个；中间产物 ${orphans.length} 个（${(bytes / 1048576).toFixed(1)} MB）`);
if (!orphans.length) { console.log('没有要清理的。'); process.exit(0); }
if (!APPLY) {
  console.log('\n预览（最多列 10 个）：');
  for (const name of orphans.slice(0, 10)) console.log('  ' + name);
  console.log('\n加 --apply 才真删。');
  process.exit(0);
}
for (const name of orphans) fs.unlinkSync(path.join(ASSETS, name));
console.log(`\n✅ 已删除 ${orphans.length} 个，释放 ${(bytes / 1048576).toFixed(1)} MB`);
