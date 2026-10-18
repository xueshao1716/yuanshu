// engine/music-stream.mjs —— 音乐流的同源代理
//
// 为什么必须代理：
//   ① B 站音轨地址要带 Referer/UA，浏览器直接引用会被 CDN 拒（404/403）；
//   ② 这些地址带 IP 绑定和过期时间（约 2 小时），由服务端每次现取最稳；
//   ③ <audio> 标签带不了 Authorization 头，鉴权走 ?token=（前端 withFileToken 会补）。
import { Readable } from 'node:stream';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ALLOWED = /(^|\.)(bilivideo\.com|bilivideo\.cn|hdslb\.com|bilibili\.com)$/i;

export function encodeStreamSource(url) {
  return Buffer.from(String(url || ''), 'utf8').toString('base64url');
}
export function decodeStreamSource(code) {
  try { return Buffer.from(String(code || ''), 'base64url').toString('utf8') } catch { return '' }
}

/** 只允许代理白名单内的媒体域，避免变成开放代理。 */
export function isAllowedStreamUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return ALLOWED.test(u.hostname);
  } catch { return false; }
}

/** 相对路径给聊天渲染用（前端会补 token）。 */
export function streamPathFor(url) {
  return `/api/music/stream?u=${encodeStreamSource(url)}`;
}

export async function handleMusicStream(req, res, { fetchImpl = fetch } = {}) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const src = decodeStreamSource(url.searchParams.get('u'));
  if (!src || !isAllowedStreamUrl(src)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('不支持的音频地址');
    return;
  }
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
  const range = req.headers.range;
  if (range) headers.Range = range;
  try {
    const upstream = await fetchImpl(src, { headers, signal: AbortSignal.timeout(20000) });
    if (!upstream.ok && upstream.status !== 206) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`音频源返回 ${upstream.status}`);
      return;
    }
    const out = {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mp4',
      'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'Cache-Control': 'no-store',
    };
    const len = upstream.headers.get('content-length');
    if (len) out['Content-Length'] = len;
    const cr = upstream.headers.get('content-range');
    if (cr) out['Content-Range'] = cr;
    res.writeHead(upstream.status === 206 ? 206 : 200, out);
    if (!upstream.body) { res.end(); return; }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('音频源超时');
  }
}
