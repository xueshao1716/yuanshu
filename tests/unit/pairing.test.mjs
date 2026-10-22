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

test('全流程：认领 → 批准 → 取令牌 → 令牌可验证', () => {
  const ws = tempWs();
  const { code } = createPairing({});
  assert.equal(claimPairing(code, { deviceName: 'Pixel', ip: IP }).ok, true);
  assert.equal(getPairing(code).status, 'claimed');

  const approved = approvePairing(ws, code, { ua: 'test-ua' });
  assert.equal(approved.ok, true);
  assert.equal(approved.deviceName, 'Pixel');

  // 已批准但还没取走：令牌字段不能从 status 泄漏
  assert.equal(getPairing(code).token, undefined);

  const taken = takePairingToken(code, { ip: IP });
  assert.equal(taken.ok, true);
  assert.equal(taken.token.length, 48);

  const device = verifyDeviceToken(ws, taken.token);
  assert.equal(device.name, 'Pixel');
  assert.equal(verifyDeviceToken(ws, 'x'.repeat(48)), null);

  // 取过即失效
  assert.equal(takePairingToken(code, { ip: IP }).ok, false);
});

test('令牌只交给认领的那个 IP', () => {
  const ws = tempWs();
  const { code } = createPairing({});
  claimPairing(code, { deviceName: 'Pixel', ip: IP });
  approvePairing(ws, code, {});
  const stolen = takePairingToken(code, { ip: '10.0.0.5' });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.reason, 'ip-mismatch');
  assert.equal(takePairingToken(code, { ip: IP }).ok, true);
});

test('过期码：认领与批准都失败', () => {
  const ws = tempWs();
  const { code } = createPairing({ ttlMs: -1 });
  assert.equal(claimPairing(code, { deviceName: 'x', ip: IP }).reason, 'expired');
  assert.equal(approvePairing(ws, code, {}).reason, 'expired');
});

test('设备列表与撤销：撤销后令牌立即失效', () => {
  const ws = tempWs();
  const { code } = createPairing({});
  claimPairing(code, { deviceName: 'Pixel', ip: IP });
  const { deviceId } = approvePairing(ws, code, {});
  assert.equal(listDevices(ws).length, 1);
  assert.ok(revokeDevice(ws, deviceId).ok);
  assert.equal(listDevices(ws).length, 0);
  assert.equal(revokeDevice(ws, deviceId).ok, false);
});

test('落盘只存哈希，不存明文令牌', () => {
  const ws = tempWs();
  const { code } = createPairing({});
  claimPairing(code, { deviceName: 'Pixel', ip: IP });
  const { token } = approvePairing(ws, code, {});
  const raw = fs.readFileSync(path.join(ws, '记忆', '运行时', '设备令牌.json'), 'utf8');
  assert.ok(!raw.includes(token), '明文令牌不能落盘');
  assert.match(raw, /tokenHash/);
});
