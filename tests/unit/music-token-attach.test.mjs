// 音乐流代理的鉴权补丁（2026-10-18）。
// withFileToken 原来只给 /api/ws/file 补 token，/api/music/stream 会被 401。
// 前端逻辑无法在 node 里直接跑（依赖模块内 token 状态），所以这里做结构性断言 +
// 独立的 URL 拼接用例，保证规则本身正确。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SRC = fs.readFileSync(new URL('../../frontend/src/api.ts', import.meta.url), 'utf8')

/** 与 api.ts 中 withFileToken 的音乐分支保持同一条规则。 */
function withMusicToken(url, { token = '', base = '' } = {}) {
  if (!url) return url
  if (!url.includes('/api/music/stream')) return url
  if (!token || /[?&]token=/.test(url)) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${base}${url}${sep}token=${encodeURIComponent(token)}`
}

test('音乐代理路径会带上 token', () => {
  assert.equal(
    withMusicToken('/api/music/stream?u=abc', { token: 't1' }),
    '/api/music/stream?u=abc&token=t1',
  )
})

test('远程实例：补全 apiBase 前缀', () => {
  assert.equal(
    withMusicToken('/api/music/stream?u=abc', { token: 't1', base: 'http://192.168.1.5:8787' }),
    'http://192.168.1.5:8787/api/music/stream?u=abc&token=t1',
  )
})

test('已有 token 不重复追加；没有 token 时原样返回', () => {
  assert.equal(withMusicToken('/api/music/stream?u=abc&token=x', { token: 't1' }), '/api/music/stream?u=abc&token=x')
  assert.equal(withMusicToken('/api/music/stream?u=abc', { token: '' }), '/api/music/stream?u=abc')
})

test('非音乐路径不受影响（不误伤图片/视频）', () => {
  assert.equal(withMusicToken('/api/ws/file?path=a.mp3', { token: 't1' }), '/api/ws/file?path=a.mp3')
  assert.equal(withMusicToken('https://cdn.example.com/a.mp3', { token: 't1' }), 'https://cdn.example.com/a.mp3')
})

test('api.ts 的 withFileToken 确实包含音乐分支', () => {
  assert.match(SRC, /function withFileToken/)
  assert.match(SRC, /\/api\/music\/stream/)
  assert.match(SRC, /token=\$\{encodeURIComponent\(_token\)\}/)
})
