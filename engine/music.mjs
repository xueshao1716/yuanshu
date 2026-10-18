// engine/music.mjs —— 对话里听歌
//
// 2026-10-18 伙伴：「能在对话里听歌就行，找找免费源」。
// 网易云匿名接口已不可用、iTunes 中文库基本为空、密码登录被风控（8810）——
// 所以分两档：
//   ① 有网易云登录 cookie（用户自己扫码拿的）→ 走本机官方 API 服务，拿**整首**直链；
//   ② 没有 cookie → Deezer 主源 / iTunes 回落，只给**30 秒试听**。
// 两种情况都不下载、不破解会员。

import fs from 'node:fs';
import path from 'node:path';
import { streamPathFor } from './music-stream.mjs';

const DEEZER = 'https://api.deezer.com/search';
const ITUNES = 'https://itunes.apple.com/search';
export const LOCAL_MUSIC_API = process.env.YUANSHU_MUSIC_API || 'http://127.0.0.1:3001';
export const DEFAULT_COOKIE_FILE = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.yuanshu', 'music-cookie.json');

export const MUSIC_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'music_search',
    description: '搜索并返回可直接播放的免费试听音频（30 秒，来自公开预览接口，无需登录）。用户想听歌/找歌时调用，然后把链接原样贴给用户——聊天里会自动出现播放器。不要声称这是完整歌曲。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '歌名、歌手或「歌手 歌名」' },
        limit: { type: 'integer', description: '返回条数，默认 5，最多 8' },
      },
      required: ['query'],
    },
  },
};

const text = (v) => String(v ?? '').trim();
const limitOf = (n) => Math.min(8, Math.max(1, Number.isInteger(n) ? n : 5));

// ── 网易云（有 cookie 才启用；能拿整首）────────────────────────────
export function readMusicCookie(file = process.env.YUANSHU_MUSIC_COOKIE_FILE || DEFAULT_COOKIE_FILE) {
  try { return String(JSON.parse(fs.readFileSync(file, 'utf8')).cookie || '').trim() } catch { return '' }
}

export function normalizeNeteaseSearch(json, limit) {
  const rows = Array.isArray(json?.result?.songs) ? json.result.songs : [];
  return rows.slice(0, limit).map((r) => ({
    id: r?.id,
    title: text(r?.name),
    artist: text(r?.ar?.[0]?.name ?? r?.artists?.[0]?.name),
    album: text(r?.al?.name ?? r?.album?.name),
    provider: 'netease',
  })).filter((r) => r.id);
}

/** 用 cookie 批量换播放直链；返回 id → url。 */
export async function neteasePlayUrls(ids, { cookie, base = LOCAL_MUSIC_API, fetchImpl = fetch } = {}) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean).slice(0, 8);
  if (!list.length || !cookie) return {};
  const url = `${base}/song/url/v1?id=${list.join(',')}&level=standard&timestamp=${Date.now()}`;
  const res = await fetchImpl(url, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(12000) });
  if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'}`);
  const json = await res.json();
  const out = {};
  for (const row of Array.isArray(json?.data) ? json.data : []) {
    if (row?.id && row?.url) out[row.id] = String(row.url).replace(/^http:/, 'https:');
  }
  return out;
}

export async function neteaseSearch(query, { limit = 5, cookie, base = LOCAL_MUSIC_API, fetchImpl = fetch } = {}) {
  const q = text(query);
  if (!q || !cookie) return { items: [], reason: 'no_cookie' };
  const n = limitOf(limit);
  const res = await fetchImpl(`${base}/cloudsearch?keywords=${encodeURIComponent(q)}&type=1&limit=${n}`, {
    headers: { Cookie: cookie }, signal: AbortSignal.timeout(12000),
  });
  if (!res?.ok) return { items: [], reason: `HTTP ${res?.status ?? '?'}` };
  const songs = normalizeNeteaseSearch(await res.json(), n);
  if (!songs.length) return { items: [], reason: 'empty' };
  let urls = {};
  try { urls = await neteasePlayUrls(songs.map((s) => s.id), { cookie, base, fetchImpl }) } catch { urls = {}; }
  return {
    items: songs.map((s) => ({
      title: s.title, artist: s.artist, album: s.album,
      previewUrl: urls[s.id] || '', link: `https://music.163.com/song?id=${s.id}`,
      seconds: 0, provider: 'netease', full: !!urls[s.id],
    })).filter((s) => s.previewUrl),
    reason: '',
  };
}

// ── B 站音轨（免登录，中文整首）────────────────────────────────────
// 汽水音乐/酷我/酷狗都要登录或签名（实测 30020/空结果），网易云要 cookie；
// B 站搜索 + playurl 匿名可用（实测 206 有数据），代价是歌来自用户上传的视频音轨。
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const cleanTitle = (s) => text(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

export function normalizeBilibiliSearch(json, limit) {
  const rows = Array.isArray(json?.data?.result) ? json.data.result : [];
  return rows.slice(0, limit).map((r) => {
    // 有的返回带 bvid，有的只给 arcurl（/video/av…），兜底从 URL 里取
    const bvid = text(r?.bvid) || (String(r?.arcurl || '').match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] ?? '');
    return {
      bvid,
      title: cleanTitle(r?.title),
      artist: cleanTitle(r?.author),
      seconds: Number(r?.duration_seconds) || 0,
      link: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
    };
  }).filter((r) => r.bvid);
}

async function biliJson(url, fetchImpl, cookie = '', extraHeaders = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com/', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    signal: AbortSignal.timeout(12000),
  });
  if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'}`);
  return res.json();
}

/** 搜索接口：带搜索页 Referer/Origin；412 是限流，退避后重试一次。 */
async function biliSearchJson(query, fetchImpl, cookie) {
  const enc = encodeURIComponent(query);
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${enc}&page=1`;
  const headers = { Referer: `https://search.bilibili.com/all?keyword=${enc}`, Origin: 'https://search.bilibili.com', Accept: 'application/json, text/plain, */*' };
  try {
    return await biliJson(url, fetchImpl, cookie, headers);
  } catch (e) {
    if (!/412/.test(String(e?.message || ''))) throw e;
    await new Promise((r) => setTimeout(r, 900));
    return await biliJson(url, fetchImpl, cookie, headers);
  }
}

/** 搜索并解析前几首的可播放音轨；返回 items（previewUrl 为同源代理路径）。 */
export async function bilibiliSearch(query, { limit = 5, fetchImpl = fetch, resolve = 4 } = {}) {
  const q = text(query);
  if (!q) return { items: [], reason: 'empty_query' };
  const n = limitOf(limit);
  let cookie = '';
  try {
    const spi = await biliJson('https://api.bilibili.com/x/frontend/finger/spi', fetchImpl);
    const b3 = text(spi?.data?.buvid3), b4 = text(spi?.data?.buvid4);
    if (b3 || b4) cookie = `buvid3=${b3}; buvid4=${b4}`;
  } catch { /* 没有 buvid 也可能能用 */ }
  const found = normalizeBilibiliSearch(
    await biliSearchJson(q, fetchImpl, cookie), n);
  if (!found.length) return { items: [], reason: 'empty' };
  const items = [];
  for (const v of found.slice(0, Math.min(resolve, n))) {
    try {
      const pages = await biliJson(`https://api.bilibili.com/x/player/pagelist?bvid=${v.bvid}`, fetchImpl, cookie);
      const cid = pages?.data?.[0]?.cid;
      if (!cid) continue;
      const pu = await biliJson(`https://api.bilibili.com/x/player/playurl?bvid=${v.bvid}&cid=${cid}&fnval=16&fourk=1`, fetchImpl, cookie);
      const track = pu?.data?.dash?.audio?.[0]?.baseUrl;
      if (!track) continue;
      items.push({ title: v.title, artist: v.artist, album: '', previewUrl: streamPathFor(track), link: v.link, seconds: v.seconds, provider: 'bilibili', full: true });
    } catch { /* 单条失败不影响其他 */ }
  }
  return { items, reason: items.length ? '' : 'no_audio' };
}

export function normalizeDeezer(json, limit) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.slice(0, limit).map((r) => ({
    title: text(r?.title),
    artist: text(r?.artist?.name),
    album: text(r?.album?.title),
    previewUrl: text(r?.preview),
    link: text(r?.link),
    seconds: Number(r?.duration) || 30,
    provider: 'deezer',
  })).filter((r) => r.previewUrl);
}

export function normalizeItunes(json, limit) {
  const rows = Array.isArray(json?.results) ? json.results : [];
  return rows.slice(0, limit).map((r) => ({
    title: text(r?.trackName),
    artist: text(r?.artistName),
    album: text(r?.collectionName),
    previewUrl: text(r?.previewUrl),
    link: text(r?.trackViewUrl),
    seconds: Math.round((Number(r?.trackTimeMillis) || 30000) / 1000),
    provider: 'itunes',
  })).filter((r) => r.previewUrl);
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'yuanshu/1.0' } });
  if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'}`);
  return res.json();
}

/** 有网易云 cookie 先走网易云（整首）；否则 Deezer → iTunes（30 秒试听）。 */
export async function searchMusic(query, { limit = 5, fetchImpl = fetch, cookie = readMusicCookie() } = {}) {
  const q = text(query);
  if (!q) return { provider: '', items: [], reason: 'empty_query' };
  const n = limitOf(limit);
  let last = '';
  if (cookie) {
    try {
      const r = await neteaseSearch(q, { limit: n, cookie, fetchImpl });
      if (r.items.length) return { provider: 'netease', items: r.items };
      last = `netease:${r.reason || 'empty'}`;
    } catch (e) { last = `netease:${String(e?.message || e).slice(0, 40)}`; }
  }
  // 中文整首：B 站优先（免登录），再回落免费试听源
  try {
    const r = await bilibiliSearch(q, { limit: n, fetchImpl });
    if (r.items.length) return { provider: 'bilibili', items: r.items };
    last = `bilibili:${r.reason || 'empty'}`;
  } catch (e) { last = `bilibili:${String(e?.message || e).slice(0, 40)}`; }
  const tries = [
    ['deezer', `${DEEZER}?q=${encodeURIComponent(q)}&limit=${n}`, normalizeDeezer],
    ['itunes', `${ITUNES}?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${n}&country=us`, normalizeItunes],
  ];
  for (const [provider, url, normalize] of tries) {
    try {
      const items = normalize(await getJson(url, fetchImpl), n);
      if (items.length) return { provider, items };
      last = `${provider}:empty`;
    } catch (e) { last = `${provider}:${String(e?.message || e).slice(0, 40)}`; }
  }
  return { provider: '', items: [], reason: last || 'no_result' };
}

export function formatMusicReply(query, result) {
  const { items = [], provider = '' } = result || {};
  if (!items.length) return `没找到「${text(query)}」的可播放音频。换个写法，比如「歌手 歌名」。`;
  const full = items.some((it) => it.full);
  const lines = items.map((it, i) => {
    const who = it.artist ? ` - ${it.artist}` : '';
    const album = it.album ? `（${it.album}）` : '';
    return `${i + 1}. ${it.title}${who}${album}\n${it.previewUrl}`;
  });
  const head = full
    ? `搜到 ${items.length} 条（网易云，整首可直接播）：`
    : `搜到 ${items.length} 条（${provider} 免费试听，30 秒，不是整首）：`;
  return [head, ...lines, '把要听的那条链接贴进对话就会自动出播放器。'].join('\n');
}

export function musicExtraExecutors({ fetchImpl } = {}) {
  return {
    music_search: async (args) => {
      try {
        const query = text(args?.query);
        const result = await searchMusic(query, { limit: args?.limit, fetchImpl: fetchImpl || fetch });
        return { text: formatMusicReply(query, result), isError: false };
      } catch (e) {
        return { text: `音乐搜索失败：${String(e?.message || e).slice(0, 120)}`, isError: true };
      }
    },
  };
}
