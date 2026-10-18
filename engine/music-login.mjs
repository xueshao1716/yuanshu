// engine/music-login.mjs —— 网易云扫码登录（自刷新二维码）
//
// 为什么要它：网易云二维码约 5 分钟过期，而人在聊天里回消息常常十几分钟——
// 靠"发一张图让它扫"必然反复失败（真机实测两次都是过期码）。
// 所以把会话放到服务端：页面每次轮询时自动检查，快过期就换新码，扫到就落盘 cookie。
//
// 只做登录这一件事：不碰账号密码（密码登录被风控 8810 拦死），只走扫码。
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_COOKIE_FILE, LOCAL_MUSIC_API } from './music.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const QR_TTL_MS = 4 * 60 * 1000; // 官方约 5 分钟，留 1 分钟余量主动换码

const cookieFile = () => process.env.YUANSHU_MUSIC_COOKIE_FILE || DEFAULT_COOKIE_FILE;
let session = null;

const now = () => Date.now();

async function get(urlPath, jar) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${LOCAL_MUSIC_API}${urlPath}`, { headers, signal: AbortSignal.timeout(12000) });
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  let body = {};
  try { body = await res.json() } catch {}
  return { status: res.status, body };
}

function readCookieFile() {
  try { return String(JSON.parse(fs.readFileSync(cookieFile(), 'utf8')).cookie || '').trim() } catch { return '' }
}

function saveCookie(cookie) {
  try {
    fs.mkdirSync(path.dirname(cookieFile()), { recursive: true });
    fs.writeFileSync(cookieFile(), JSON.stringify({ cookie, at: new Date().toISOString() }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

async function startSession() {
  const jar = new Map();
  const keyRes = await get(`/login/qr/key?timestamp=${now()}`, jar);
  const key = keyRes.body?.data?.unikey;
  if (!key) throw new Error('拿不到二维码 key');
  const create = await get(`/login/qr/create?key=${key}&qrimg=true&timestamp=${now()}`, jar);
  const qrimg = create.body?.data?.qrimg;
  if (!qrimg) throw new Error('拿不到二维码图片');
  session = { key, qrimg, jar, startedAt: now(), state: 801, message: '等待扫码' };
  return session;
}

/** 页面轮询入口：保证二维码新鲜，并同步一次扫码状态。 */
export async function musicLoginView() {
  const loggedIn = !!readCookieFile();
  if (!session || now() - session.startedAt > QR_TTL_MS) {
    try { await startSession() } catch (e) {
      session = null;
      return { ok: false, error: String(e?.message || e).slice(0, 120), loggedIn };
    }
  }
  try {
    const r = await get(`/login/qr/check?key=${session.key}&timestamp=${now()}`, session.jar);
    const code = r.body?.code;
    if (code === 803) {
      const cookie = r.body?.cookie || [...session.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (saveCookie(cookie)) session.state = 803, session.message = '登录成功';
    } else if (code && code !== session.state) {
      session.state = code;
      session.message = code === 802 ? '已扫描，请在手机上确认' : code === 800 ? '二维码已过期（马上换新码）' : (r.body?.message || '');
      if (code === 800) { try { await startSession() } catch {} }
    }
  } catch (e) {
    session.message = `查询失败：${String(e?.message || e).slice(0, 60)}`;
  }
  return {
    ok: true,
    loggedIn: !!readCookieFile(),
    state: session.state,
    message: session.message,
    qrimg: session.qrimg,
    expiresInMs: Math.max(0, QR_TTL_MS - (now() - session.startedAt)),
  };
}

/** 供测试或手动重置。 */
export function resetMusicLogin() { session = null; }
