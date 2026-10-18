// B 站音轨源 + 同源代理（2026-10-18）。
// 背景：汽水音乐无公开接口；酷我/酷狗要签名或登录（实测 30020 / 空结果）；
// B 站搜索+playurl 匿名可用，但 CDN 要 Referer、地址会过期 → 必须走同源代理。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeBilibiliSearch, bilibiliSearch, searchMusic,
} from '../../engine/music.mjs'
import {
  isAllowedStreamUrl, encodeStreamSource, decodeStreamSource, streamPathFor,
} from '../../engine/music-stream.mjs'

const SEARCH = { code: 0, data: { result: [
  { bvid: 'BV1BZbSzZEGT', title: '【Hi-Res】晴天<em class="keyword">周杰伦</em>', author: 'VV音乐局', duration_seconds: 270 },
  { arcurl: 'http://www.bilibili.com/video/BV1xx411c7mD', title: '无 bvid 但有 arcurl', author: 'up' },
] } }
const PAGES = { code: 0, data: [{ cid: 123 }] }
const PLAY = { code: 0, data: { dash: { audio: [{ baseUrl: 'https://xy1x.mcdn.bilivideo.cn:8082/v1/a.m4s?e=1' }] } } }

const fake = (map) => async (url) => {
  for (const [k, v] of Object.entries(map)) if (String(url).includes(k)) return { ok: true, status: 200, json: async () => v }
  return { ok: false, status: 412, json: async () => ({ code: -412 }) }
}

test('搜索归一化：去掉 HTML 标签，缺 bvid 时从 arcurl 兜底', () => {
  const items = normalizeBilibiliSearch(SEARCH, 5)
  assert.equal(items.length, 2)
  assert.equal(items[0].bvid, 'BV1BZbSzZEGT')
  assert.doesNotMatch(items[0].title, /<em/)
  assert.equal(items[1].bvid, 'BV1xx411c7mD')
})

test('解析出可播放音轨，返回同源代理路径', async () => {
  const r = await bilibiliSearch('晴天', { limit: 2, fetchImpl: fake({ '/search/type': SEARCH, pagelist: PAGES, playurl: PLAY }) })
  assert.equal(r.items.length, 2, '两条都应拿到音轨')
  assert.match(r.items[0].previewUrl, /^\/api\/music\/stream\?u=[A-Za-z0-9_-]+$/)
  assert.equal(r.items[0].full, true)
  assert.equal(r.items[0].provider, 'bilibili')
})

test('只有白名单域名允许代理，防止变成开放代理', () => {
  assert.equal(isAllowedStreamUrl('https://xy1x.mcdn.bilivideo.cn:8082/v1/a.m4s'), true)
  assert.equal(isAllowedStreamUrl('https://upos-sz.bilivideo.com/x'), true)
  assert.equal(isAllowedStreamUrl('https://evil.example.com/a.mp3'), false)
  assert.equal(isAllowedStreamUrl('file:///C:/secret.txt'), false)
  assert.equal(isAllowedStreamUrl('http://127.0.0.1:8787/api/ws/file?path=x'), false)
  assert.equal(isAllowedStreamUrl(''), false)
})

test('代理源编码可往返', () => {
  const src = 'https://xy1x.mcdn.bilivideo.cn:8082/v1/a.m4s?e=1&deadline=2'
  assert.equal(decodeStreamSource(encodeStreamSource(src)), src)
  assert.match(streamPathFor(src), /^\/api\/music\/stream\?u=/)
})

test('没有网易云 cookie 时优先 B 站整首，而不是 30 秒试听', async () => {
  const r = await searchMusic('晴天', {
    cookie: '',
    fetchImpl: fake({ '/finger/spi': { code: 0, data: { buvid3: 'b3', buvid4: 'b4' } }, '/search/type': SEARCH, pagelist: PAGES, playurl: PLAY }),
  })
  assert.equal(r.provider, 'bilibili')
  assert.ok(r.items.every((i) => i.full === true))
})

test('B 站失败时仍回落免费试听源', async () => {
  const r = await searchMusic('adele', {
    cookie: '',
    fetchImpl: async (url) => {
      if (String(url).includes('itunes.apple.com')) return { ok: true, json: async () => ({ results: [{ trackName: 'Hello', artistName: 'Adele', previewUrl: 'https://a/x.m4a' }] }) }
      return { ok: false, status: 412, json: async () => ({}) }
    },
  })
  assert.equal(r.provider, 'itunes')
})
