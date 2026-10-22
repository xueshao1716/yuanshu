// engine/pairing.mjs —— 扫码配对登录（2026-10-22）
//
// 目的：让手机（含微信里打开的网页）不用手输 token 就能登录，且可以被单独撤销。
//
// 设计取舍：
//  · **一次性码**：8 位、默认 120 秒过期、只能被认领一次；桌面端点「允许」才发令牌。
//  · **设备令牌只存哈希**：落盘 `记忆/运行时/设备令牌.json` 存 sha256，明文只返回一次（手机存 localStorage）。
//  · **可撤销**：每台设备一条记录，撤销即失效；不会影响主人的主 token。
//  · 不做微信 OAuth：那需要开放平台"网站应用"资质（企业主体 + 认证费 + 审核）。
//    "微信扫一扫"扫的是本机局域网 URL，走的是微信内置浏览器，不需要微信账号授权。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEVICE_FILE = '记忆/运行时/设备令牌.json';
const CODE_TTL_MS = 120_000;
const sessions = new Map(); // code -> { code, createdAt, expiresAt, status, deviceName, deviceId, token }

function rand(n = 8) {
  // 去掉易混字符（0/O/1/I）
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function devicePath(wsRoot) { return path.join(wsRoot, DEVICE_FILE); }

function readDevices(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(devicePath(wsRoot), 'utf8'));
    return Array.isArray(raw?.devices) ? raw.devices : [];
  } catch { return [] }
}

function writeDevices(wsRoot, devices) {
  const file = devicePath(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2), 'utf8');
  fs.renameSync(tmp, file); // 先写临时文件再改名，避免写一半掉电留下坏 JSON
}

function sweep(now = Date.now()) {
  for (const [code, s] of sessions) if (s.expiresAt <= now) sessions.delete(code);
}

/** 创建一次性配对码（桌面端调用，需已登录） */
export function createPairing({ baseUrl = '', ttlMs = CODE_TTL_MS } = {}) {
  sweep();
  const code = rand(8);
  const now = Date.now();
  const session = { code, createdAt: now, expiresAt: now + ttlMs, status: 'pending', deviceName: '', deviceId: '' };
  sessions.set(code, session);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return {
    code,
    expiresAt: session.expiresAt,
    ttlMs,
    url: base ? `${base}/pair/${code}` : `/pair/${code}`,
  };
}

export function getPairing(code) {
  sweep();
  const s = sessions.get(String(code || '').toUpperCase());
  if (!s) return { status: 'expired' };
  return { status: s.status, deviceName: s.deviceName, expiresAt: s.expiresAt };
}

/** 手机端认领（公开接口）：只标记"谁在扫"，不发放任何凭据 */
export function claimPairing(code, { deviceName = '', ip = '' } = {}) {
  sweep();
  const s = sessions.get(String(code || '').toUpperCase());
  if (!s) return { ok: false, reason: 'expired' };
  if (s.status === 'approved') return { ok: false, reason: 'already-approved' };
  s.status = 'claimed';
  s.deviceName = String(deviceName || '').slice(0, 60) || '未命名设备';
  s.ip = String(ip || ''); // 令牌只交给认领它的那个 IP，防止别人抢走已批准的码
  return { ok: true, status: 'claimed' };
}

/** 桌面端批准（需已登录）：签发设备令牌，明文只在这里返回一次 */
export function approvePairing(wsRoot, code, { ua = '' } = {}) {
  sweep();
  const s = sessions.get(String(code || '').toUpperCase());
  if (!s) return { ok: false, reason: 'expired' };
  if (s.status === 'approved') return { ok: false, reason: 'already-approved' };
  const token = crypto.randomBytes(24).toString('hex');
  const device = {
    id: `d_${crypto.randomBytes(4).toString('hex')}`,
    name: s.deviceName || '未命名设备',
    tokenHash: sha256(token),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    ua: String(ua || '').slice(0, 200),
  };
  const devices = readDevices(wsRoot);
  devices.push(device);
  writeDevices(wsRoot, devices);
  s.status = 'approved';
  s.deviceId = device.id;
  s.token = token; // 只在这台会话里暂存，手机拿走即删
  return { ok: true, deviceId: device.id, deviceName: device.name, token };
}

/** 校验设备令牌：命中返回设备信息（不回传令牌本身） */
export function verifyDeviceToken(wsRoot, token) {
  const t = String(token || '').trim();
  if (!t || t.length < 16) return null;
  const want = sha256(t);
  const devices = readDevices(wsRoot);
  const hit = devices.find((d) => d.tokenHash === want);
  if (!hit) return null;
  // 记录最近使用（最多每分钟写一次，避免每个请求都落盘）
  try {
    const last = hit.lastSeenAt ? Date.parse(hit.lastSeenAt) : 0;
    if (!last || Date.now() - last > 60_000) {
      hit.lastSeenAt = new Date().toISOString();
      writeDevices(wsRoot, devices);
    }
  } catch {}
  return { id: hit.id, name: hit.name, createdAt: hit.createdAt, lastSeenAt: hit.lastSeenAt };
}


/** 手机端取令牌：仅当同一 IP 认领且已被批准，取一次即失效 */
export function takePairingToken(code, { ip = '' } = {}) {
  sweep();
  const s = sessions.get(String(code || '').toUpperCase());
  if (!s) return { ok: false, reason: 'expired' };
  if (s.status !== 'approved' || !s.token) return { ok: false, reason: 'not-approved' };
  if (s.ip && String(ip || '') !== s.ip) return { ok: false, reason: 'ip-mismatch' };
  const token = s.token;
  sessions.delete(s.code);
  return { ok: true, token, deviceId: s.deviceId };
}
export function listDevices(wsRoot) {
  return readDevices(wsRoot).map((d) => ({
    id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, ua: d.ua,
  }));
}

export function revokeDevice(wsRoot, id) {
  const devices = readDevices(wsRoot);
  const next = devices.filter((d) => d.id !== id);
  if (next.length === devices.length) return { ok: false, reason: 'not-found' };
  writeDevices(wsRoot, next);
  return { ok: true, id };
}
