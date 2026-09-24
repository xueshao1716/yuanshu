import test from 'node:test'
import assert from 'node:assert/strict'

async function access() {
  const mod = await import('../../frontend/src/lib/file-access.ts').catch(() => ({}))
  assert.equal(typeof mod.fileAccess, 'function', 'file access must renew historical workspace links')
  return mod.fileAccess
}
test('old signed workspace video is rebound to this device and current credentials', async () => {
  const resolve = await access()
  const r = resolve('http://127.0.0.1:8787/api/ws/file?path=生成物/video.mp4&sig=stale&exp=1&token=old', 'https://my.example', 'new#token', true)
  const url = new URL(r.url)
  assert.equal(url.origin, 'https://my.example')
  assert.equal(url.searchParams.get('path'), '生成物/video.mp4')
  assert.equal(url.searchParams.has('sig'), false)
  assert.equal(url.searchParams.has('exp'), false)
  assert.equal(url.searchParams.has('token'), false, 'fetch downloads authenticate in headers only')
  assert.equal(url.searchParams.get('download'), '1')
  assert.equal(r.headers.Authorization, 'Bearer new#token')
})
test('media elements still receive an encoded token because they cannot send headers', async () => {
  const resolve = await access()
  const r = resolve('/api/ws/file?path=生成物/image.png', '', 'new#token')
  assert.equal(new URL(r.url, 'https://local.example').searchParams.get('token'), 'new#token')
})
test('external video keeps its signature and receives no workspace credential', async () => {
  const resolve = await access()
  const url = 'https://cdn.example/video.mp4?sig=external'
  assert.deepEqual(resolve(url, '', 'secret'), { url, headers: {} })
})
test('signed sharing remains available without local login, API downloads use current base', async () => {
  const resolve = await access()
  assert.match(resolve('/api/ws/file?path=x.mp4&sig=s&exp=9', '', '').url, /sig=s/)
  const r = resolve('/api/sessions/abc/export?format=html', 'https://my.example', 'token')
  assert.equal(r.url, 'https://my.example/api/sessions/abc/export?format=html')
  assert.equal(r.headers.Authorization, 'Bearer token')
})
