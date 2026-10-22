import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createPairing, getPairing, claimPairing, approvePairing, takePairingToken,
  verifyDeviceToken, listDevices, revokeDevice,
} from '../../engine/pairing.mjs';

function tempWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-'));
  fs.mkdirSync(path.join(dir, '记忆', '运行时'), { recursive: true });
  return dir;
}

const IP = '192.168.0.9';

test('配对码：8 位、含过期时间、不重复', () => {
  const a = createPairing({ baseUrl: 'http://192.168.0.2:8787' });
  const b = createPairing({});
  assert.equal(a.code.length, 8);
  assert.notEqual(a.code, b.code);
  assert.match(a.code, /^[A-Z2-9]+$/);
  assert.ok(a.expiresAt > Date.now());
  assert.equal(a.url, `http://192.168.0.2:8787/pair/${a.code}`);
  assert.equal(getPairing(a.code).status, 'pending');
});

test('全流程：认领 → 批准 → 凭 claimToken 取令牌 → 令牌可验证', () => {
  const ws = tempWs();
  const { code } = createPairing({});
  const claimed = claimPairing(code, { deviceName: 'Pixel', ip: IP, wsRoot: ws });
  assert.equal(claimed.ok, true);
  assert.ok(claimed.claimToken, '认领要发一枚 claimToken');
  assert.equal(getPairing(code).status, 'claimed');

  const approved = approvePairing(ws, code, { ua: 'test-ua' });
  assert.equal(approved.ok, true);
  assert.equal(approved.deviceName, 'Pixel');

  // status 不能泄漏令牌
  assert.equal(getPairing(code).token, undefined);

  const taken = takePairingToken(code, { claimToken: claimed.claimToken, ip: IP, wsRoot: ws });
  assert.equal(taken.ok, true);
  assert.equal(taken.token.length, 48);

  const device = verifyDeviceToken(ws, taken.token);
  assert.equal(device.name, 'Pixel');
  assert.ok(device.lastSeenAt, '取走令牌即视为用过，不该再显示"尚未使用"');
  assert.equal(verifyDeviceToken(ws, 'x'.repeat(48)), null);

  // 取过即失效
  assert.equal(takePairingToken(code, { claimToken: claimed.claimToken, ip: IP, wsRoot: ws }).ok, false);
});

test('claimToken 不对取不到令牌（IP 变了也不影响）', () => {
  const ws = tempWs();
  const { code } = createPairing({});
  const claimed = claimPairing(code, { deviceName: 'Pixel', ip: IP, wsRoot: ws });
  approvePairing(ws, code, {});

  // 错误凭据 → 拒绝
  const bad = takePairingToken(code, { claimToken: 'f'.repeat(32), ip: IP, wsRoot: ws });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-claim');

  // 手机 IPv6 轮换导致 IP 不同，但凭据对 → 仍然放行（这正是线上"尚未使用"的成因）
  const ok = takePairingToken(code, { claimToken: claimed.claimToken, ip: '10.9.9.9', wsRoot: ws });
  assert.equal(ok.ok, true);
});

test('重复批准同一码：幂等，不新建设备', () => {
  const ws = tempWs();
  const { code } = createPairing({});
  claimPairing(code, { deviceName: 'Pixel', ip: IP, wsRoot: ws });
  const first = approvePairing(ws, code, { ua: 'ua-1' });
  const second = approvePairing(ws, code, { ua: 'ua-1' });
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.deviceId, first.deviceId);
  assert.equal(listDevices(ws).length, 1);
});

test('上次没拿到令牌的幽灵条目：同名同 UA 会被替换，不堆垃圾', () => {
  const ws = tempWs();
  const mk = (name, ua) => {
    const { code } = createPairing({});
    claimPairing(code, { deviceName: name, ip: IP, wsRoot: ws });
    approvePairing(ws, code, { ua });
  };
  mk('Android 15', 'same-ua');
  assert.equal(listDevices(ws).length, 1);
  mk('Android 15', 'same-ua'); // 重试一次（没取令牌）
  assert.equal(listDevices(ws).length, 1, '同名同 UA 且未使用 → 应替换而不是累积');
  mk('Android 15', 'same-ua');
  assert.equal(listDevices(ws).length, 1);
});

test('过期码：认领与批准都失败', () => {
  const ws = tempWs();
  const { code } = createPairing({ ttlMs: -1 });
  assert.equal(claimPairing(code, { deviceName: 'x', ip: IP, wsRoot: ws }).reason, 'expired');
  assert.equal(approvePairing(ws, code, {}).reason, 'expired');
});

test('设备列表与撤销：撤销后令牌立即失效', () => {
  const ws = tempWs();
  const { code } = createPairing({});
  const claimed = claimPairing(code, { deviceName: 'Pixel', ip: IP, wsRoot: ws });
  const { deviceId } = approvePairing(ws, code, {});
  const { token } = takePairingToken(code, { claimToken: claimed.claimToken, ip: IP, wsRoot: ws });
  assert.equal(listDevices(ws).length, 1);
  assert.ok(revokeDevice(ws, deviceId).ok);
  assert.equal(listDevices(ws).length, 0);
  assert.equal(verifyDeviceToken(ws, token), null);
  assert.equal(revokeDevice(ws, deviceId).ok, false);
});

test('落盘只存哈希，不存明文令牌', () => {
  const ws = tempWs();
  const { code } = createPairing({});
  const claimed = claimPairing(code, { deviceName: 'Pixel', ip: IP, wsRoot: ws });
  approvePairing(ws, code, {});
  const { token } = takePairingToken(code, { claimToken: claimed.claimToken, ip: IP, wsRoot: ws });
  const raw = fs.readFileSync(path.join(ws, '记忆', '运行时', '设备令牌.json'), 'utf8');
  assert.ok(!raw.includes(token), '明文令牌不能落盘');
  assert.match(raw, /tokenHash/);
});

test('配对留痕：claim / approve / token 都写日志', () => {
  const ws = tempWs();
  const { code } = createPairing({});
  const claimed = claimPairing(code, { deviceName: 'Pixel', ip: IP, wsRoot: ws });
  approvePairing(ws, code, {});
  takePairingToken(code, { claimToken: claimed.claimToken, ip: IP, wsRoot: ws });
  const log = fs.readFileSync(path.join(ws, '记忆', '运行时', '配对日志.log'), 'utf8');
  assert.match(log, /claim/);
  assert.match(log, /approve/);
  assert.match(log, /token/);
});
