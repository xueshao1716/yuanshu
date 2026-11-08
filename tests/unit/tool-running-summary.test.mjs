// 工具条运行时摘要（2026-11-08）。
//
// 真痛点：工具执行中只显示"运行中"，用户不知道它到底在跑什么命令、读哪个文件。
// toolRunningSummary 是纯函数：把 name + args 压成一行可展示的摘要（≤80 字、单行、脱敏）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toolRunningSummary } from '../../frontend/src/lib/tool-summary.ts';

test('命令类：bash/pwsh/shell 取命令首行，折叠空白', () => {
  assert.equal(toolRunningSummary('bash', { command: 'npm test -- --grep "a b"' }), 'npm test -- --grep "a b"');
  assert.equal(toolRunningSummary('pwsh', { command: 'npm test\nrm -rf dist' }), 'npm test', '只取首行');
  assert.equal(toolRunningSummary('shell', { command: '\n   ls   -la  \n' }), 'ls -la');
  assert.equal(toolRunningSummary('bash', 'npm test'), 'npm test', '流式 argsText 可能已经是裸命令');
});

test('文件类：read/write/edit 取路径，能拿到 cwd 就相对化', () => {
  assert.equal(toolRunningSummary('read', { path: 'D:/pi-web/engine/reflection-exec.mjs' }, { cwd: 'D:/pi-web' }), 'engine/reflection-exec.mjs');
  assert.equal(toolRunningSummary('write', { path: 'D:\\pi-web\\frontend\\src\\a.ts' }, { cwd: 'D:\\pi-web' }), 'frontend/src/a.ts');
  assert.equal(toolRunningSummary('edit', { path: '/repo/src/a.ts' }), '/repo/src/a.ts', '没有 cwd 就原样显示');
  assert.equal(toolRunningSummary('read', 'D:/pi-web/a.mjs'), 'D:/pi-web/a.mjs', '流式 argsText 可能已经是路径');
});

test('链接类：web_fetch/read_url 取 URL', () => {
  assert.equal(toolRunningSummary('web_fetch', { url: 'https://example.com/path?q=1' }), 'https://example.com/path?q=1');
  assert.equal(toolRunningSummary('read_url', { url: 'https://mp.weixin.qq.com/s/abc' }), 'https://mp.weixin.qq.com/s/abc');
});

test('搜索类：web_search 取查询词；search_files/grep 取查询或模式', () => {
  assert.equal(toolRunningSummary('web_search', { query: '元枢 fix_problem 观察任务' }), '元枢 fix_problem 观察任务');
  assert.equal(toolRunningSummary('search_files', { query: '酒店的ppt' }), '酒店的ppt');
  assert.equal(toolRunningSummary('grep', { pattern: 'fix_problem' }), 'fix_problem');
});

test('当场修/派活：fix_problem 取 problem，delegate_task/subagent 取任务标题', () => {
  assert.equal(toolRunningSummary('fix_problem', { problem: '给 abort 用例的 bash 路径加引号' }), '给 abort 用例的 bash 路径加引号');
  assert.equal(toolRunningSummary('delegate_task', { task: '调研 X 方案', context: ['背景'] }), '调研 X 方案');
  assert.equal(toolRunningSummary('subagent', { title: '跑一遍回归' }), '跑一遍回归');
});

test('其它工具：取参数里第一个字符串值；没有就返回空串', () => {
  assert.equal(toolRunningSummary('mystery_tool', { alpha: 'first', beta: 'second' }), 'first');
  assert.equal(toolRunningSummary('mystery_tool', { alpha: 42, beta: true }), '');
  assert.equal(toolRunningSummary('mystery_tool', undefined), '');
  assert.equal(toolRunningSummary('bash', {}), '');
  assert.equal(toolRunningSummary('', { path: 'a.mjs' }), 'a.mjs', '名字缺失也尽量给点信息');
});

test('摘要必须单行、截断 80 字', () => {
  const long = `x${'y'.repeat(200)}`;
  const s = toolRunningSummary('bash', { command: long });
  assert.ok(s.length <= 81, `截断后不该超过 81 字，实际 ${s.length}`);
  assert.ok(s.endsWith('…'), '截断要有省略号');
  const multiline = toolRunningSummary('mystery_tool', { note: 'line1\nline2\r\nline3' });
  assert.equal(multiline, 'line1 line2 line3');
});

test('脱敏：token/key/secret/password/authorization 字段跳过，命令行里的凭据打码', () => {
  assert.equal(toolRunningSummary('mystery_tool', { token: 'sk-1234567890' }), '', '只有密钥字段时宁可不显示');
  assert.equal(toolRunningSummary('mystery_tool', { api_key: 'sk-1234567890', query: '找一下这个文件' }), '找一下这个文件');
  assert.equal(toolRunningSummary('mystery_tool', { password: 'p@ss', note: 'hello' }), 'hello');
  assert.equal(toolRunningSummary('mystery_tool', { authorization: 'Bearer abcdef' }), '');
  const curl = toolRunningSummary('bash', { command: 'curl -H "Authorization: Bearer sk-abcdef123456" https://example.com' });
  assert.ok(!curl.includes('sk-abcdef123456'), `命令行里的 Bearer 不许漏：${curl}`);
  const flag = toolRunningSummary('bash', { command: 'deploy --token=abc123 --env prod' });
  assert.ok(!flag.includes('abc123'), `--token= 不许漏：${flag}`);
});

test('JSON 字符串参数也能解析（历史消息里的 argsText）', () => {
  assert.equal(toolRunningSummary('web_search', '{"query":"酒店 ppt"}'), '酒店 ppt');
  assert.equal(toolRunningSummary('bash', '{"command":"npm run build"}'), 'npm run build');
  assert.equal(toolRunningSummary('read', '{"path":"a/b.ts"}'), 'a/b.ts');
});

test('渲染层：运行中带摘要，完成后仍是原来的 argsText 展示', () => {
  const src = fs.readFileSync('frontend/src/components/chat/Message.tsx', 'utf8');
  assert.match(src, /import \{ toolRunningSummary \} from '\.\.\/\.\.\/lib\/tool-summary'/, '工具卡要引入摘要函数');
  assert.match(src, /running\s*\?\s*toolRunningSummary\(/, '只在运行中计算摘要');
  assert.ok(src.includes('{runningSummary}'), '运行中要真的渲染出摘要');
  assert.ok(src.includes('{argsText}'), '完成后保持原有展示不变');
});
