// Windows 上的两个老坑（编码 / cmd 引号）——engine/windows-shell.mjs 的治法要有测试守着。
// 用户的原话："经常踩 gbk 编码，以及 cmd 引号转义的坑怎么治"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withUtf8CodePage, decodeWindowsOutput, looksMojibake, riskyForCmdShell, UTF8_PREFIX } from '../../engine/windows-shell.mjs';

test('编码：UTF-8 原样通过，GBK 字节自动兜底解回中文，两边都不认时不丢内容', () => {
  const zh = '元枢：中文测试 ✅';
  assert.equal(decodeWindowsOutput(Buffer.from(zh, 'utf8')), zh);
  // 把同一句话按 GBK 编码（模拟 cmd 里那些按 936 打印的工具）
  const gbk = Buffer.from([0xd4, 0xaa, 0xca, 0xe0, 0xa3, 0xba, 0xd6, 0xd0, 0xce, 0xc4]); // "元枢：中文"
  assert.equal(decodeWindowsOutput(gbk), '元枢：中文');
  // 全 0xFF 这种两边都不认的：返回 utf8 结果，而不是抛错或返回空
  const junk = Buffer.from([0xff, 0xfe, 0xfd]);
  assert.equal(typeof decodeWindowsOutput(junk), 'string');
  assert.ok(decodeWindowsOutput(junk).length > 0);
  // 非 Windows 平台不做 GBK 猜测（避免在 UTF-8 环境里误判）
  assert.equal(decodeWindowsOutput(gbk, { platform: 'linux' }).includes('\uFFFD'), true);
  assert.equal(decodeWindowsOutput(null), '');
});

test('编码：乱码判定只认铁证（不误伤正常中文/emoji）', () => {
  assert.equal(looksMojibake('正常的中文输出 ✅'), false);
  assert.equal(looksMojibake('这里有 \uFFFD 替换字符'), true);
  assert.equal(looksMojibake('私用区 \uE123 出现在输出里'), true);
  // 刻意不猜"错码汉字"：`鍏冩灑` 本身就是合法汉字，猜错会给正常输出贴标签。
  // 真正的治法在 decodeWindowsOutput（切代码页 + GBK 兜底），不是事后识别。
  assert.equal(looksMojibake('[鍏冩灑] 浼氳瘽鐩綍'), false);
});

test('引号：cmd 分支加 UTF-8 代码页前缀，bash/非 Windows 不加', () => {
  assert.equal(withUtf8CodePage('echo hi', { platform: 'win32' }), UTF8_PREFIX + 'echo hi');
  assert.match(withUtf8CodePage('echo hi', { platform: 'win32' }), /^chcp 65001>nul & /);
  // 已经切过就不重复加
  assert.equal(withUtf8CodePage('chcp 65001>nul & echo hi', { platform: 'win32' }), 'chcp 65001>nul & echo hi');
  // bash 那一支不加（bash 本来就是 UTF-8）
  assert.equal(withUtf8CodePage('echo hi', { platform: 'win32', shell: 'C:/Program Files/Git/usr/bin/bash.exe' }), 'echo hi');
  assert.equal(withUtf8CodePage('echo hi', { platform: 'linux' }), 'echo hi');
  assert.equal(withUtf8CodePage('', { platform: 'win32' }), '');
});

test('引号：能提前认出"过 cmd 大概会被拆坏"的两类命令', () => {
  assert.match(riskyForCmdShell('node -e "console.log(1)"'), /内联代码/);
  assert.match(riskyForCmdShell('python -c "print(1)"'), /内联代码/);
  assert.match(riskyForCmdShell('C:\\Program Files\\nodejs\\node.exe -v'), /空格/);
  // 加了引号就不该再报
  assert.equal(riskyForCmdShell('"C:\\Program Files\\nodejs\\node.exe" -v'), null);
  // 干净命令不报
  assert.equal(riskyForCmdShell('git status --short'), null);
  assert.equal(riskyForCmdShell(''), null);
});

test('接线：bash 工具要走同一套解码与前缀，且提示词里写清了规矩', () => {
  const tools = fs.readFileSync('engine/tools/unified-tools.mjs', 'utf8');
  assert.match(tools, /decodeWindowsOutput\(stdout\)/, 'stdout 要走共享解码（UTF-8 → GBK 兜底）');
  assert.match(tools, /decodeWindowsOutput\(stderr\)/, 'stderr 同样');
  assert.match(tools, /withUtf8CodePage\(runCmd, \{ shell \}\)/, 'cmd 分支要切代码页');
  assert.match(tools, /\/c", cmdWithCodepage/, '真正执行的是切过代码页的那条命令');
  assert.match(tools, /riskyForCmdShell\(cmd\)/, '失败时要给出"过 cmd 有风险"的提示');
  const desc = fs.readFileSync('engine/tools/unified-tools.mjs', 'utf8');
  assert.match(desc, /写中文内容一律用 write 工具/, '工具描述里要写清编码规矩');
  assert.match(desc, /路径带空格必须加引号/, '工具描述里要写清引号规矩');
});

test('纪律层：这份 playbook 技能必须存在且能被匹配到（别只留在代码里）', () => {
  const skill = fs.readFileSync('skills/windows-shell-playbook/SKILL.md', 'utf8');
  assert.match(skill, /^name: windows-shell-playbook$/m);
  assert.match(skill, /当.*用：/, 'description 要写触发条件（技能契约的硬要求）');
  assert.match(skill, /chcp 65001/, '要写清代码页这一手');
  assert.match(skill, /Get-Content/, '要点名 PowerShell 整文件读写的坑');
  assert.match(skill, /"C:\\Program Files/, '要写清带空格路径加引号');
  const desc = (skill.match(/^description: (.+)$/m) || [])[1] || '';
  assert.ok(desc.length <= 120, `description 过长（${desc.length} 字）`);
});
