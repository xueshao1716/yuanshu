// 工具语义对齐（2026-09-16 量测出来的主因）。
//
// 同一个模型：在 pi 通道一条 `grep -n` 就拿到答案（1 次调用）；在自研循环里拿到的是 cmd.exe，
// 只能猜 `findstr`/`dir /b`，试 5~7 次还有失败——"自研循环工具调用翻倍、更慢"就是这么来的。
// 修法：循环的 bash 也走 git-bash（与 pi 一致），描述随实际 shell 变化，别让模型自己猜。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('bash 工具：优先真 bash，描述随实际 shell 走，绝不认 WSL 启动器', async () => {
  const mod = await import('../../engine/tools/unified-tools.mjs');
  const shell = mod.detectBashShell();
  const desc = mod.bashToolDescription();
  if (process.platform === 'win32' && shell) {
    assert.match(shell, /bash\.exe$/i, '要指向真的 bash 可执行文件');
    assert.ok(!/System32[\\/]bash\.exe/i.test(shell), 'WSL 启动器不算（MSYS 风格 /d/... 路径进去会失败）');
    assert.match(desc, /git-bash|MINGW/i, '描述必须说清是 bash');
    assert.ok(!/cmd\.exe/.test(desc), '已经在用 bash，描述里不能再写 cmd');
    assert.match(desc, /grep/, '要给出 Unix 命令示例');
  } else {
    assert.match(desc, /cmd\.exe/, '没有 bash 时才退回 cmd 描述');
  }
  const schema = mod.BASE_TOOL_SCHEMAS.find((x) => x.function.name === 'bash');
  assert.match(schema.function.description, /git-bash|MINGW|cmd\.exe/, 'schema 里的描述要真的是动态那份');
});

test('bash 优先用 usr\\bin 下的真 bash，而不是 bin 启动器（多一层进程 = 多一个杀不掉的孤儿）', async () => {
  const mod = await import('../../engine/tools/unified-tools.mjs');
  if (process.platform !== 'win32') return;
  const real = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
  if (!fs.existsSync(real)) return; // 这台机器没装 Git 就算了，不能凭这个判红
  assert.ok(
    /usr[\\/]bin[\\/]bash\.exe$/i.test(mod.detectBashShell()),
    `装了 Git 就要挑真 bash 本体，实际拿到 ${mod.detectBashShell()}`,
  );
});

test('执行器：有 bash 就用 bash -lc，没有才 cmd /c；内联代码仍走临时文件（abort 才杀得掉）', () => {
  const src = fs.readFileSync('engine/tools/unified-tools.mjs', 'utf8');
  assert.match(src, /const shell = detectBashShell\(\)/);
  assert.match(src, /execFileAbortable\(shell, \["-lc", cmd\]/, '要真的用 bash 跑命令');
  // bash 下也要做内联代码改写：`bash -lc 'node -e …'` 被 abort 时只杀 bash，node 成孤儿（真机把 abort 用例拖到 30s）
  // cmd 那一支走的是**切过代码页**的命令（2026-09-18：cmd 默认 936，输出与重定向都按 GBK 走）
  assert.match(src, /const fixed = rewriteInlineCode\(shell \? cmd : cmdWithCodepage\)/, '两种 shell 都要能改写内联代码');
  assert.match(src, /cmdWithCodepage = withUtf8CodePage\(runCmd, \{ shell \}\)/, 'cmd 分支要切 UTF-8 代码页');
  assert.match(src, /if \(process\.platform === "win32" && !shell\) ensureCommandDirectories/, 'bash 不需要 cmd 的目录兜底');
  assert.match(src, /execFileAbortable\(process\.env\.ComSpec \|\| "cmd\.exe", \["\/c", cmdWithCodepage\]/, '没 bash 时仍要能退回 cmd（并带上代码页）');
});
