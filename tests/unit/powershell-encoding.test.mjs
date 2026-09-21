// PowerShell 脚本编码约束（2026-09-14）
//
// 为什么值得锁：本会话被同一个坑咬了两次——
//   1) scripts/restart-pi-web.ps1 是中文且无 BOM，用 `powershell -File` 执行时
//      把脚本原文当输出打了出来，并且**静默失败**（服务没起来，退出码却是 0）。
//   2) autostart.ps1 同样是中文无 BOM，PowerShell 解析器按 ANSI 解码后中文变乱码，
//      乱码里出现的假引号让解析报「字符串未终结」，而错误行号完全指不到真因。
//
// 还有一条相反方向的约束：install-lite.ps1 是设计给 `irm ... | iex` 的引导器，
// 它的前提是**纯 ASCII**（这样不管 PowerShell 用什么编码解码都不会坏）。
// 但它一度在注释里塞了中文——正好破坏了它自己的设计前提。
//
// 所以两条不变量：含非 ASCII 的 .ps1 必须带 UTF-8 BOM；install-lite.ps1 必须纯 ASCII。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = /node_modules|[\\/]dist[\\/]|\.worktrees|build[\\/]intermediates|\.git[\\/]/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP.test(path.sep + path.relative(ROOT, full) + path.sep)) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.toLowerCase().endsWith('.ps1')) out.push(full);
  }
  return out;
}

const hasBom = buf => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
const nonAsciiCount = buf => buf.reduce((n, byte) => (byte > 127 ? n + 1 : n), 0);

test('含非 ASCII 的 .ps1 必须带 UTF-8 BOM，否则 powershell -File 会静默失败或解析报错', () => {
  const scripts = walk(ROOT);
  assert.ok(scripts.length > 0, '至少要扫到几个 .ps1，否则说明路径写错了');
  const offenders = scripts
    .map(file => ({ file: path.relative(ROOT, file), buf: fs.readFileSync(file) }))
    .filter(({ buf }) => nonAsciiCount(buf) > 0 && !hasBom(buf))
    .map(({ file }) => file);
  assert.deepEqual(offenders, [], `这些 .ps1 含中文却没有 UTF-8 BOM：${offenders.join('、')}`);
});

test('install-lite.ps1 必须保持纯 ASCII：它是要被 `irm | iex` 直接管道执行的', () => {
  const file = path.join(ROOT, 'install-lite.ps1');
  assert.ok(fs.existsSync(file), 'install-lite.ps1 是 README 推荐的一行安装入口，不能消失');
  const buf = fs.readFileSync(file);
  const offenders = nonAsciiCount(buf);
  assert.equal(offenders, 0, `install-lite.ps1 含 ${offenders} 个非 ASCII 字节；管道执行时会被解码成乱码，中文请写进 install-all.ps1`);
  // 它必须把 -InstallDir 之类的参数透传给 install-all.ps1
  const text = buf.toString('utf8');
  assert.match(text, /&\s*\$d\s+@args/, 'install-lite.ps1 必须把参数透传给 install-all.ps1');
});
