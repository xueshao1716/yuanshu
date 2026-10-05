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
// 流水线：npm run deploy:frontend = build → prune --apply → sync（顺序不能反，
// 先 sync 会把未清理的全集镜像进 app/dist 和 public）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 只碰 vite 生成的指纹文件，手写资源（favicon、manifest 等）一律不动
const FINGERPRINT = /-[A-Za-z0-9_\-]{8}\.(?:js|css)$/;

function gitEntryHtmls({ root, keep }) {
  let refs = [];
  try {
    refs = execFileSync('git', ['log', `-${keep}`, '--format=%H', '--', 'frontend/dist/index.html'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
  const out = [];
  for (const ref of refs) {
    try { out.push({ ref, html: execFileSync('git', ['show', `${ref}:frontend/dist/index.html`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }); } catch {}
  }
  return out;
}

/**
 * 计算并（可选）删除不可达的指纹分块。
 * @param {{distDir?:string, apply?:boolean, keep?:number, extraEntries?:{ref:string,html:string}[]|null, log?:(s:string)=>void}} opts
 *   extraEntries 为 null 时从 git 历史取最近 keep 个入口；测试可直接注入。
 */
export function pruneDist({ distDir = path.join(ROOT, 'frontend/dist'), apply = false, keep = 2, extraEntries = null, log = () => {} } = {}) {
  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(assetsDir)) throw new Error(`找不到 ${assetsDir}，先在 frontend 里执行构建。`);
  const assetNames = new Set(fs.readdirSync(assetsDir));

  // 从一段文本里抠出指向 assets 下真实存在的文件名
  // （html 里是 assets/xxx.js，js 里是 ./xxx.js；两种前缀都剥掉）
  const harvest = (text) => {
    const out = [];
    for (const m of String(text).matchAll(/[A-Za-z0-9_][A-Za-z0-9_.\-]*\.(?:js|css)/g)) {
      const name = m[0].replace(/^\.\//, '').replace(/^assets\//, '');
      if (assetNames.has(name)) out.push(name);
    }
    return out;
  };
  const reachable = new Set();
  const crawl = (seeds) => {
    const queue = [...seeds];
    while (queue.length) {
      const name = queue.pop();
      if (reachable.has(name) || !assetNames.has(name)) continue;
      reachable.add(name);
      queue.push(...harvest(fs.readFileSync(path.join(assetsDir, name), 'utf8')));
    }
  };

  crawl(harvest(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')));
  log('当前 dist/index.html 可达: ' + reachable.size);
  const entries = extraEntries ?? gitEntryHtmls({ root: ROOT, keep });
  for (const { ref, html } of entries) {
    const before = reachable.size;
    crawl(harvest(html));
    log(`  + 保留 ${String(ref).slice(0, 8)} 的入口，新增可达 ${reachable.size - before} 个`);
  }

  const orphans = [...assetNames].filter(name => FINGERPRINT.test(name) && !reachable.has(name));
  let bytes = 0;
  for (const name of orphans) bytes += fs.statSync(path.join(assetsDir, name)).size;
  if (apply) for (const name of orphans) fs.unlinkSync(path.join(assetsDir, name));
  return { reachable: reachable.size, orphans, bytes, applied: apply };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const keepIndex = argv.indexOf('--keep');
  const keep = keepIndex >= 0 ? Math.max(1, Number(argv[keepIndex + 1]) || 2) : 2;
  const apply = argv.includes('--apply');
  let r;
  try { r = pruneDist({ apply, keep, log: s => console.log(s) }); }
  catch (e) { console.error(e.message); process.exit(1); }
  const mb = (r.bytes / 1048576).toFixed(1);
  console.log(`\n可达分块 ${r.reachable} 个；中间产物 ${r.orphans.length} 个（${mb} MB）`);
  if (!r.orphans.length) console.log('没有要清理的。');
  else if (!apply) {
    console.log('\n预览（最多列 10 个）：');
    for (const name of r.orphans.slice(0, 10)) console.log('  ' + name);
    console.log('\n加 --apply 才真删。');
  } else console.log(`\n✅ 已删除 ${r.orphans.length} 个，释放 ${mb} MB`);
}
