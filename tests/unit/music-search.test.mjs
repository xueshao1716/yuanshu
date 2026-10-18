// 对话里听歌的免费源（2026-10-18）。
// 网易云匿名接口已不可用、iTunes 中文库基本为空；实测 Deezer 中文能出结果，iTunes 作全球回落。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  searchMusic, normalizeDeezer, normalizeItunes, formatMusicReply, musicExtraExecutors, MUSIC_TOOL_SCHEMA,
  normalizeNeteaseSearch, neteasePlayUrls, neteaseSearch, readMusicCookie,
} from '../../engine/music.mjs'

const DEEZER_JSON = { data: [
  { title: '七里香', artist: { name: '周杰伦' }, album: { title: '七里香' }, preview: 'https://cdns-preview.dzcdn.net/x/1.mp3', duration: 299, link: 'https://deezer.com/track/1' },
  { title: '无预览', artist: { name: 'x' }, preview: '', duration: 10 },
] }
const ITUNES_JSON = { results: [
  { trackName: 'Jay', artistName: 'Jay Chou', collectionName: 'Album', previewUrl: 'https://audio-ssl.itunes.apple.com/y/2.m4a', trackTimeMillis: 30000 },
] }

const fakeFetch = (map) => async (url) => {
  for (const [k, v] of Object.entries(map)) if (String(url).includes(k)) return { ok: true, json: async () => v };
  return { ok: false, status: 500 };
}

test('Deezer 结果归一化，丢弃没有试听直链的条目', () => {
  const items = normalizeDeezer(DEEZER_JSON, 5)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, '七里香')
  assert.equal(items[0].artist, '周杰伦')
  assert.match(items[0].previewUrl, /\.mp3$/)
  assert.equal(items[0].provider, 'deezer')
})

test('iTunes 结果归一化', () => {
  const items = normalizeItunes(ITUNES_JSON, 5)
  assert.equal(items[0].title, 'Jay')
  assert.match(items[0].previewUrl, /\.m4a$/)
  assert.equal(items[0].provider, 'itunes')
})

test('主源有结果就用主源', async () => {
  const r = await searchMusic('周杰伦', { fetchImpl: fakeFetch({ 'api.deezer.com': DEEZER_JSON }) })
  assert.equal(r.provider, 'deezer')
  assert.equal(r.items.length, 1)
})

test('主源空结果时回落 iTunes', async () => {
  const r = await searchMusic('jay', { fetchImpl: fakeFetch({ 'api.deezer.com': { data: [] }, 'itunes.apple.com': ITUNES_JSON }) })
  assert.equal(r.provider, 'itunes')
  assert.equal(r.items.length, 1)
})

test('两个源都空时返回 no_result，不抛错', async () => {
  const r = await searchMusic('zzz', { fetchImpl: fakeFetch({ 'api.deezer.com': { data: [] }, 'itunes.apple.com': { results: [] } }) })
  assert.equal(r.items.length, 0)
  assert.ok(r.reason)
})

test('空查询直接返回，不发请求', async () => {
  let called = 0
  const r = await searchMusic('   ', { fetchImpl: async () => { called++; return { ok: true, json: async () => ({}) } } })
  assert.equal(called, 0)
  assert.equal(r.reason, 'empty_query')
})

test('条数上限 8，防止刷屏', async () => {
  const many = { data: Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, artist: { name: 'a' }, preview: `https://x/${i}.mp3`, duration: 30 })) }
  const r = await searchMusic('x', { limit: 99, fetchImpl: fakeFetch({ 'api.deezer.com': many }) })
  assert.equal(r.items.length, 8)
})

test('回复文本带直链、并说明只是试听', () => {
  const text = formatMusicReply('周杰伦', { provider: 'deezer', items: normalizeDeezer(DEEZER_JSON, 5) })
  assert.match(text, /30 秒/)
  assert.match(text, /不是整首/)
  assert.match(text, /https:\/\/cdns-preview\.dzcdn\.net/)
})

test('工具执行器：成功返回文本，失败不抛错', async () => {
  const ok = await musicExtraExecutors({ fetchImpl: fakeFetch({ 'api.deezer.com': DEEZER_JSON }) }).music_search({ query: '周杰伦' })
  assert.equal(ok.isError, false)
  assert.match(ok.text, /七里香/)
  const bad = await musicExtraExecutors({ fetchImpl: async () => { throw new Error('boom') } }).music_search({ query: 'x' })
  assert.equal(bad.isError, false, '两源都失败时应给出"没找到"而不是报错')
})

test('schema 名称与必填参数', () => {
  assert.equal(MUSIC_TOOL_SCHEMA.function.name, 'music_search')
  assert.deepEqual(MUSIC_TOOL_SCHEMA.function.parameters.required, ['query'])
})

// ── 网易云（有 cookie 时优先，拿整首）────────────────────────────
const NE_SEARCH = { result: { songs: [
  { id: 111, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美' } },
  { id: 222, name: '七里香', ar: [{ name: '周杰伦' }], al: { name: '七里香' } },
] } }
const NE_URL = { data: [
  { id: 111, url: 'http://m801.music.126.net/a/1.mp3' },
  { id: 222, url: null },
] }
const fake = (map) => async (url) => {
  for (const [k, v] of Object.entries(map)) if (String(url).includes(k)) return { ok: true, json: async () => v }
  return { ok: false, status: 500 }
}

test('网易云搜索结果归一化', () => {
  const items = normalizeNeteaseSearch(NE_SEARCH, 5)
  assert.equal(items.length, 2)
  assert.equal(items[0].title, '晴天')
  assert.equal(items[0].artist, '周杰伦')
  assert.equal(items[0].id, 111)
})

test('播放直链只收有 url 的，并升级成 https', async () => {
  const urls = await neteasePlayUrls([111, 222], { cookie: 'MUSIC_U=x', fetchImpl: fake({ '/song/url/v1': NE_URL }) })
  assert.equal(urls[111], 'https://m801.music.126.net/a/1.mp3')
  assert.equal(urls[222], undefined, '没有直链的（VIP/无版权）不返回')
})

test('有 cookie 时优先网易云，并标记整首', async () => {
  const r = await searchMusic('晴天', { cookie: 'MUSIC_U=x', fetchImpl: fake({ '/cloudsearch': NE_SEARCH, '/song/url/v1': NE_URL }) })
  assert.equal(r.provider, 'netease')
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].full, true)
  assert.match(formatMusicReply('晴天', r), /整首/)
})

test('没有 cookie 时不请求网易云', async () => {
  let hit = 0
  const probe = async (url) => { if (String(url).includes('cloudsearch')) hit++; return { ok: true, json: async () => ({ data: [] }) } }
  await searchMusic('x', { cookie: '', fetchImpl: probe })
  assert.equal(hit, 0)
})

test('网易云失败时回落到免费试听源', async () => {
  const r = await searchMusic('jay', { cookie: 'MUSIC_U=x', fetchImpl: fake({ '/cloudsearch': { result: { songs: [] } }, 'api.deezer.com': DEEZER_JSON }) })
  assert.equal(r.provider, 'deezer')
})

test('cookie 文件缺失时读成空串，不抛错', () => {
  assert.equal(readMusicCookie('Z:/definitely/not/here.json'), '')
})
