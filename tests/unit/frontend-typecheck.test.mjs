// 前端类型检查（2026-09-17 加的一条硬线）。
//
// 为什么必须有一条：真机上报「连续创作」整页白屏，错误详情是
//   ReferenceError: Cannot access 'nt' before initialization
// ——压缩后的变量名，翻译回来是：`const effectiveCardId = project?.colorCardId || globalCardId || ''`
// 写在 `const [globalCardId, setGlobalCardId] = useState('')` **之前**，渲染时读到还没初始化的绑定（TDZ）。
// vite build 不做类型检查，eslint 也没接；这类错误只有 tsc 拦得住（TS2448/TS2454），
// 而它一出就是整页白屏——所以把它变成红灯，而不是等用户撞上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSC = join(ROOT, 'frontend', 'node_modules', 'typescript', 'bin', 'tsc');

test('前端必须过 tsc 类型检查（"先用后声明"这类白屏 bug 只有它拦得住）', { skip: !existsSync(TSC) ? '没装 typescript' : false }, () => {
  let out = '';
  try {
    out = execFileSync(process.execPath, [TSC, '--noEmit', '-p', join(ROOT, 'frontend', 'tsconfig.json')], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  const errors = out.split('\n').filter(line => /error TS\d+/.test(line));
  assert.deepEqual(errors.slice(0, 10), [], `类型检查没过（前 10 条）：\n  ${errors.slice(0, 10).join('\n  ')}`);
});

// 只靠测试线还不够：真正发版走的是 `npm run build:frontend`，它必须自己挡住类型错误——
// 否则本地测试绿了、线上产物里照样是白屏（2026-09-17 连续创作白屏就是这么出去的）。
test('构建流水线必须先跑类型检查（否则类型错误进不了产物，也进不了任何人的视野）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'frontend', 'package.json'), 'utf8'));
  assert.match(pkg.scripts.typecheck || '', /tsc --noEmit/, 'frontend 要有独立的 typecheck 脚本');
  assert.match(pkg.scripts.build || '', /typecheck/, 'frontend build 必须先跑 typecheck 再 vite build');
  assert.match(pkg.scripts.build || '', /vite build/, 'typecheck 之后仍然要真的构建');
  // 根目录那条发版命令必须落到 frontend 的 build 上（别绕过它直接用 npx vite）
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(rootPkg.scripts['build:frontend'] || '', /--prefix frontend run build/, '根 build:frontend 要走 frontend 的 build 脚本');
  assert.ok(!/vite build/.test(rootPkg.scripts['build:frontend'] || ''), '根脚本不得绕过 frontend 的 typecheck');
});
