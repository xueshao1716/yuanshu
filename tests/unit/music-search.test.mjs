// 对话里听歌的免费源（2026-10-18）。
// 网易云匿名接口已不可用、iTunes 中文库基本为空；实测 Deezer 中文能出结果，iTunes 作全球回落。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  searchMusic, normalizeDeezer, normalizeItunes, formatMusicReply, musicExtraExecutors, MUSIC_TOOL_SCHEMA,
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
