// engine/pairing.mjs —— 扫码配对登录（2026-10-22）
//
// 目的：让手机（含微信里打开的网页）不用手输 token 就能登录，且可以被单独撤销。
//
// 设计取舍：
//  · **一次性码**：8 位、默认 120 秒过期、只能被认领一次；桌面端点「允许」才发令牌。
//  · **认领凭据**：认领时发一枚 claimToken，取令牌必须带它——
//    2026-10-22 实测教训：只按 IP 绑定会因 IPv4/IPv6 混用或地址轮换让手机取不到令牌
//    （设备列表出现"尚未使用"的幽灵条目），改成凭据绑定，IP 只记日志不再拦。
//  · **设备令牌只存哈希**：落盘 `记忆/运行时/设备令牌.json` 存 sha256，明文只返回一次。
//  · **可撤销**：每台设备一条记录，撤销即失效；不影响主人的主 token。
//  · 不做微信 OAuth：需要开放平台"网站应用"资质（企业主体 + 认证费 + 审核）。
//    "微信扫一扫"扫的是本机局域网 URL，走微信内置浏览器，不需要微信账号授权。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEVICE_FILE = '记忆/运行时/设备令牌.json';
export const PAIR_LOG_FILE = '记忆/运行时/配对日志.log';
const CODE_TTL_MS = 120_000;
const sessions = new Map(); // code -> { code, createdAt, expiresAt, status, deviceName, ip, claimHash, deviceId, token }

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

/** 配对留痕：出问题（手机没拿到令牌）时能看出断在哪一步，不用猜 */
export function pairLog(wsRoot, event, detail = {}) {
  try {
    const dir = path.join(wsRoot, '记忆', '运行时');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(wsRoot, PAIR_LOG_FILE);
    try { if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, file + '.1'); } catch {}
    const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}`;
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch {}
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

/** 手机端认领（公开接口）：只标记"谁在扫"，不发放访问令牌；返回 claimToken 供取令牌时出示 */
export function claimPairing(code, { deviceName = '', ip = '', wsRoot = '' } = {}) {
  sweep();
  const s = sessions.get(String(code || '').toUpperCase());
  if (!s) { if (wsRoot) pairLog(wsRoot, 'claim', { code, ok: false, reason: 'expired', ip }); return { ok: false, reason: 'expired' }; }
  if (s.status === 'approved') {
    if (wsRoot) pairLog(wsRoot, 'claim', { code, ok: false, reason: 'already-approved', ip });
    return { ok: false, reason: 'already-approved' };
  }
  s.status = 'claimed';
  s.deviceName = String(deviceName || '').slice(0, 60) || '未命名设备';
  s.ip = String(ip || '');
  s.claimHash = sha256(crypto.randomBytes(16).toString('hex') + code);
  const claimToken = crypto.randomBytes(16).toString('hex');
  // 只存哈希；明文随响应交给手机（手机在取令牌时出示）
  s.claimHash = sha256(claimToken);
  if (wsRoot) pairLog(wsRoot, 'claim', { code, ok: true, deviceName: s.deviceName, ip });
  return { ok: true, status: 'claimed', claimToken };
}

/** 桌面端批准（需已登录）：签发设备令牌；重复批准返回同一台设备，不再新建 */
export function approvePairing(wsRoot, code, { ua = '' } = {}) {
  sweep();
  const s = sessions.get(String(code || '').toUpperCase());
  if (!s) return { ok: false, reason: 'expired' };
  if (s.status === 'approved' && s.token) {
    pairLog(wsRoot, 'approve', { code, ok: true, reason: 'idempotent', deviceId: s.deviceId });
    return { ok: true, deviceId: s.deviceId, deviceName: s.deviceName, token: s.token, idempotent: true };
  }
  const token = crypto.randomBytes(24).toString('hex');
  const devices = readDevices(wsRoot);
  // 同名同 UA 且刚创建、从未使用过的（上次没拿到令牌的幽灵条目）直接替换掉，避免列表堆垃圾
  const dupWindow = 10 * 60_000;
  for (let i = devices.length - 1; i >= 0; i--) {
    const d = devices[i];
    const fresh = Date.now() - Date.parse(d.createdAt || 0) < dupWindow;
    if (fresh && !d.lastSeenAt && d.name === (s.deviceName || '未命名设备') && String(d.ua || '') === String(ua || '')) devices.splice(i, 1);
  }
  const device = {
    id: `d_${crypto.randomBytes(4).toString('hex')}`,
    name: s.deviceName || '未命名设备',
    tokenHash: sha256(token),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    ua: String(ua || '').slice(0, 200),
  };
  devices.push(device);
  writeDevices(wsRoot, devices);
  s.status = 'approved';
  s.deviceId = device.id;
  s.token = token; // 只在这台会话里暂存，手机拿走即删
  pairLog(wsRoot, 'approve', { code, ok: true, deviceId: device.id, name: device.name });
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

/** 手机端取令牌：凭 claimToken 认领身份（IP 只记日志，不再拦），取一次即失效 */
export function takePairingToken(code, { claimToken = '', ip = '', wsRoot = '' } = {}) {
  sweep();
  const s = sessions.get(String(code || '').toUpperCase());
  if (!s) { if (wsRoot) pairLog(wsRoot, 'token', { code, ok: false, reason: 'expired', ip }); return { ok: false, reason: 'expired' } }
  if (s.status !== 'approved' || !s.token) {
    if (wsRoot) pairLog(wsRoot, 'token', { code, ok: false, reason: 'not-approved', ip });
    return { ok: false, reason: 'not-approved' };
  }
  const okClaim = !!claimToken && !!s.claimHash && sha256(claimToken) === s.claimHash;
  const ipMismatch = !!s.ip && String(ip || '') !== s.ip;
  if (!okClaim) {
    if (wsRoot) pairLog(wsRoot, 'token', { code, ok: false, reason: 'bad-claim', ip, ipMismatch });
    return { ok: false, reason: 'bad-claim' };
  }
  const token = s.token;
  sessions.delete(s.code);
  // 拿到令牌就算"用过一次"，列表里不该再显示"尚未使用"
  try {
    const devices = readDevices(wsRoot);
    const d = devices.find((x) => x.id === s.deviceId);
    if (d) { d.lastSeenAt = new Date().toISOString(); writeDevices(wsRoot, devices); }
  } catch {}
  pairLog(wsRoot, 'token', { code, ok: true, deviceId: s.deviceId, ip, ipMismatch });
  return { ok: true, token, deviceId: s.deviceId };
}

export function listDevices(wsRoot) {
  // 新的在前：界面上最近加入的设备应当排第一
  return readDevices(wsRoot).slice().reverse().map((d) => ({
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
