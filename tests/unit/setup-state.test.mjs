import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SETUP_REVIEWER, setupPendingPath, markSetupPending, isSetupPending, clearSetupPending,
  normalizeSetupSoul, applySetupSoul, isLocalSetupRequest,
} from '../../engine/setup-state.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'setup-state-'));

test('pending 标记：写入 / 查询 / 清除，重复清除不报错', () => {
  const dir = tmp();
  try {
    assert.equal(isSetupPending(dir), false);
    assert.equal(markSetupPending(dir), true);
    assert.equal(isSetupPending(dir), true);
    assert.match(fs.readFileSync(setupPendingPath(dir), 'utf8'), /^\d{4}-\d{2}-\d{2}T/);
    clearSetupPending(dir);
    assert.equal(isSetupPending(dir), false);
    clearSetupPending(dir); // ENOENT 忽略
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending 标记：目录不存在时 mark 返回 false 而不是抛错', () => {
  assert.equal(markSetupPending(path.join(os.tmpdir(), 'no-such-dir-' + Date.now(), 'x')), false);
});

test('config.mjs 只在新生成令牌时落 pending 标记；.gitignore 排除标记', () => {
  const config = fs.readFileSync(new URL('../../config.mjs', import.meta.url), 'utf8');
  const gen = config.indexOf('crypto.randomBytes(24)');
  const mark = config.indexOf('markSetupPending(path.dirname(TOKEN_FILE))');
  assert.ok(gen > 0 && mark > gen, '标记必须在生成新令牌分支里');
  const ignore = fs.readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.ok(ignore.split(/\r?\n/).includes('.setup-*'));
});

test('normalizeSetupSoul：只收 name/called，去空白', () => {
  assert.deepEqual(normalizeSetupSoul({ name: ' 阿青 ', called: '老板' }), { name: '阿青', called: '老板' });
  assert.deepEqual(normalizeSetupSoul({}), {});
  assert.deepEqual(normalizeSetupSoul(), {});
});

test('normalizeSetupSoul：拒绝越权字段、空值、超长、控制字符、非对象', () => {
  assert.throws(() => normalizeSetupSoul({ age: 30 }), /向导不允许修改字段：age/);
  assert.throws(() => normalizeSetupSoul({ kind: 'x' }), /不允许修改字段/);
  assert.throws(() => normalizeSetupSoul({ name: '   ' }), /名字不能为空/);
  assert.throws(() => normalizeSetupSoul({ called: 5 }), /称呼不能为空/);
  assert.throws(() => normalizeSetupSoul({ name: '一'.repeat(21) }), /最多 20 个字/);
  assert.throws(() => normalizeSetupSoul({ called: 'a\nb' }), /控制字符/);
  assert.throws(() => normalizeSetupSoul(null), /必须为对象/);
  assert.throws(() => normalizeSetupSoul(['x']), /必须为对象/);
});

function mockGovernance({ prepareError } = {}) {
  const calls = { prepare: [], commit: [] };
  const definition = { name: '小语', called: '伙伴', age: 20 };
  return {
    calls,
    read: () => ({ definition, revision: 'rev-1', source: 'file' }),
    prepare(action, body) {
      calls.prepare.push({ action, body });
      if (prepareError) throw new Error(prepareError);
      return { beforeRevision: body.expectedRevision, patch: body.definition };
    },
    commit(plan, reviewer) {
      calls.commit.push({ plan, reviewer });
      return { ok: true, definition: { ...definition, ...plan.patch } };
    },
  };
}

test('applySetupSoul：空补丁直接视为确认默认值，不走治理写入', () => {
  const g = mockGovernance();
  const r = applySetupSoul(g, {});
  assert.deepEqual(r, { ok: true, unchanged: true, definition: g.read().definition });
  assert.equal(g.calls.prepare.length, 0);
  assert.equal(g.calls.commit.length, 0);
});

test('applySetupSoul：有改动时带版本号 prepare，再以向导身份 commit', () => {
  const g = mockGovernance();
  const r = applySetupSoul(g, { name: '阿青' });
  assert.equal(r.unchanged, false);
  assert.equal(r.definition.name, '阿青');
  assert.equal(g.calls.prepare[0].action, 'apply');
  assert.equal(g.calls.prepare[0].body.expectedRevision, 'rev-1');
  assert.deepEqual(g.calls.prepare[0].body.definition, { name: '阿青' });
  assert.ok(g.calls.prepare[0].body.reason);
  assert.equal(g.calls.commit[0].reviewer, SETUP_REVIEWER);
});

test('applySetupSoul：「没有需要保存的修改」视为 unchanged，其余错误上抛', () => {
  const same = mockGovernance({ prepareError: '没有需要保存的修改' });
  assert.equal(applySetupSoul(same, { name: '小语' }).unchanged, true);
  assert.equal(same.calls.commit.length, 0);
  const bad = mockGovernance({ prepareError: '人格版本已变化或缺少版本，请重新读取并审查差异' });
  assert.throws(() => applySetupSoul(bad, { name: '阿青' }), /人格版本已变化/);
  assert.throws(() => applySetupSoul(mockGovernance(), { age: 1 }), /不允许修改字段/);
});

const req = (addr, headers) => ({ socket: { remoteAddress: addr }, headers });

test('isLocalSetupRequest：本机直连（含 Tauri / 浏览器同源）放行', () => {
  assert.equal(isLocalSetupRequest(req('127.0.0.1', { host: '127.0.0.1:8787' }), 8787), true);
  assert.equal(isLocalSetupRequest(req('::1', { host: 'localhost:8787', origin: 'http://localhost:8787' }), 8787), true);
  assert.equal(isLocalSetupRequest(req('::ffff:127.0.0.1', { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' }), 8787), true);
});

test('isLocalSetupRequest：局域网、隧道、DNS rebinding、跨源一律拒绝', () => {
  // 局域网手机
  assert.equal(isLocalSetupRequest(req('192.168.1.20', { host: '192.168.1.5:8787' }), 8787), false);
  // cloudflared 隧道：来源是回环，但带代理头 / 公网 Host
  assert.equal(isLocalSetupRequest(req('127.0.0.1', { host: '127.0.0.1:8787', 'cf-connecting-ip': '1.2.3.4' }), 8787), false);
  assert.equal(isLocalSetupRequest(req('127.0.0.1', { host: '127.0.0.1:8787', 'x-forwarded-for': '1.2.3.4' }), 8787), false);
  assert.equal(isLocalSetupRequest(req('127.0.0.1', { host: 'yuanshu.example.com' }), 8787), false);
  // DNS rebinding：解析到 127.0.0.1 的外部域名
  assert.equal(isLocalSetupRequest(req('127.0.0.1', { host: 'evil.test:8787' }), 8787), false);
  // 本机其他网页跨源调用
  assert.equal(isLocalSetupRequest(req('127.0.0.1', { host: '127.0.0.1:8787', origin: 'http://evil.test' }), 8787), false);
  assert.equal(isLocalSetupRequest(req('127.0.0.1', { host: '127.0.0.1:8787', origin: 'null' }), 8787), false);
  // 端口不符、缺 Host、缺 socket
  assert.equal(isLocalSetupRequest(req('127.0.0.1', { host: '127.0.0.1:9999' }), 8787), false);
  assert.equal(isLocalSetupRequest(req('127.0.0.1', {}), 8787), false);
  assert.equal(isLocalSetupRequest({}, 8787), false);
});

test('server 路由：status/claim 免鉴权，claim 在路由内校验 pending + 本机，令牌查询不再旁路', () => {
  const server = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes('["GET", "/api/setup/status"'));
  assert.ok(server.includes('["POST", "/api/setup/soul"'));
  assert.ok(server.includes('["POST", "/api/setup/done"'));
  const claim = server.slice(server.indexOf('["POST", "/api/setup/claim"'));
  const give = claim.indexOf('{ token: CONFIG.token }'); // 注意别匹配到 CONFIG.tokenFile
  assert.ok(give > 0, 'claim 路由应返回令牌');
  assert.ok(claim.indexOf('isSetupPending') >= 0 && claim.indexOf('isSetupPending') < give);
  assert.ok(claim.indexOf('isLocalSetupRequest') >= 0 && claim.indexOf('isLocalSetupRequest') < give);
  // 只查声明（注释里提到旧名不算）
  assert.equal(/\b(?:const|let|var)\s+isTokenCheck\b/.test(server), false, 'GET /api/system/token 不得免鉴权');
});
