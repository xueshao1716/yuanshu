// 环境变量新旧双读（2026-09-14）
//
// 产品名已统一为「元枢 / Yuanshu」，环境变量前缀从 PI_WEB_* 迁到 YUANSHU_*。
// 但老安装的 shell profile、计划任务、systemd unit 里导出的还是 PI_WEB_*，
// 直接改名会让这些变量被**静默忽略**——端口、监听地址、默认模型悄悄退回默认值，
// 这是最难查的一类故障。所以两个都读，新名优先。
//
// 这条测试就是防止以后有人把它当"死代码"清理掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// config.mjs 在 import 时就计算好 CONFIG，所以必须在子进程里改 env 再取
function readConfig(env) {
  const script = "import('./config.mjs').then(m => process.stdout.write(JSON.stringify({"
    + 'port: m.CONFIG.port, host: m.CONFIG.host, model: m.CONFIG.model, '
    + 'tools: m.CONFIG.tools, corsOrigins: m.CONFIG.corsOrigins, '
    + 'cwd: m.CONFIG.cwd, externalThinking: m.CONFIG.externalThinking })))';
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (/^(PI_WEB|YUANSHU)_/.test(key)) delete base[key];
  // This test only observes configuration; do not create/read a service token.
  base.YUANSHU_TOKEN = 'config-test-only';
  const out = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8' });
  return JSON.parse(out.trim());
}

test('旧前缀 PI_WEB_* 仍然生效：老安装升级后配置不能被静默忽略', () => {
  const cfg = readConfig({ PI_WEB_PORT: '1111', PI_WEB_MODEL: 'legacy/model', PI_WEB_TOOLS: 'read,edit' });
  assert.equal(cfg.port, 1111, 'PI_WEB_PORT 必须仍被采纳');
  assert.equal(cfg.model, 'legacy/model', 'PI_WEB_MODEL 必须仍被采纳');
  assert.deepEqual(cfg.tools, ['read', 'edit'], 'PI_WEB_TOOLS 必须仍被采纳');
});

test('新前缀 YUANSHU_* 是新装与文档的正式写法', () => {
  const cfg = readConfig({ YUANSHU_PORT: '2222', YUANSHU_MODEL: 'new/model' });
  assert.equal(cfg.port, 2222);
  assert.equal(cfg.model, 'new/model');
});

test('两个前缀同时存在时新名优先，且不因旧名留空而回落默认值', () => {
  assert.equal(readConfig({ YUANSHU_PORT: '2222', PI_WEB_PORT: '1111' }).port, 2222, '新名必须优先');
  // 空字符串的旧变量视同未设置，不能把端口变成 NaN
  const cfg = readConfig({ PI_WEB_PORT: '   ' });
  assert.equal(cfg.port, 8787, '空白旧值必须回落默认端口而不是 NaN');
  assert.equal(readConfig({ YUANSHU_PORT: '', PI_WEB_PORT: '3333' }).port, 3333, '新名为空时应继续认旧名');
});

test('局域网监听开关与 CORS、外部思考开关在两个前缀下行为一致', () => {
  assert.equal(readConfig({ PI_WEB_LAN: '1' }).host, '0.0.0.0', '旧名 PI_WEB_LAN=1 仍要能开局域网');
  assert.equal(readConfig({ YUANSHU_LAN: '1' }).host, '0.0.0.0', '新名 YUANSHU_LAN=1 要能开局域网');
  assert.equal(readConfig({}).host, '127.0.0.1', '默认仍只监听本机');
  // 显式 HOST 优先于 LAN 开关
  assert.equal(readConfig({ YUANSHU_LAN: '1', YUANSHU_HOST: '10.0.0.5' }).host, '10.0.0.5');
  assert.equal(readConfig({ YUANSHU_CORS_ORIGINS: 'https://a.example' }).corsOrigins, 'https://a.example');
  assert.equal(readConfig({ PI_WEB_EXTERNAL_THINKING: '1' }).externalThinking, true);
  assert.equal(readConfig({ YUANSHU_EXTERNAL_THINKING: '1' }).externalThinking, true);
  assert.equal(readConfig({}).externalThinking, false);
});
