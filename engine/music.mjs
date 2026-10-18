// engine/music.mjs —— 对话里听歌：免费源搜索（无需 key、无需登录）
//
// 2026-10-18 伙伴：「能在对话里听歌就行，找找免费源」。
// 实测：网易云匿名接口已不可用（返回 0），iTunes 中文库基本为空；Deezer 中文能出结果。
// 所以主源用 Deezer，回落 iTunes（全球库），都只提供**30 秒试听直链**——
// 不下载、不破解会员，链接是对方 CDN 的公开 preview，前端 <audio> 直接播。
//
// 注意：先说清"这是试听"，不要把 30 秒当成整首歌交付。

const DEEZER = 'https://api.deezer.com/search';
const ITUNES = 'https://itunes.apple.com/search';

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

/** 主源 Deezer，空结果或失败回落 iTunes。返回 { provider, items }。 */
export async function searchMusic(query, { limit = 5, fetchImpl = fetch } = {}) {
  const q = text(query);
  if (!q) return { provider: '', items: [], reason: 'empty_query' };
  const n = limitOf(limit);
  const tries = [
    ['deezer', `${DEEZER}?q=${encodeURIComponent(q)}&limit=${n}`, normalizeDeezer],
    ['itunes', `${ITUNES}?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${n}&country=us`, normalizeItunes],
  ];
  let last = '';
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
  if (!items.length) return `没找到「${text(query)}」的可播放试听（免费源只有 30 秒公开预览）。换个写法，比如「歌手 歌名」。`;
  const lines = items.map((it, i) => {
    const who = it.artist ? ` - ${it.artist}` : '';
    const album = it.album ? `（${it.album}）` : '';
    return `${i + 1}. ${it.title}${who}${album}\n${it.previewUrl}`;
  });
  return [`搜到 ${items.length} 条（${provider} 免费试听，30 秒，不是整首）：`, ...lines, '把要听的那条链接贴进对话就会自动出播放器。'].join('\n');
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
