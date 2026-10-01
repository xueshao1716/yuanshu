import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const navigation = () => import('../../frontend/src/lib/browser-navigation.ts')

test('browser addresses accept local ports and relative URLs but reject executable schemes', async () => {
  const { resolveBrowserUrl } = await navigation()
  const base = 'http://127.0.0.1:8787/'
  for (const [input, expected] of [
    ['localhost:3000', 'http://localhost:3000/'], ['127.0.0.1:54098', 'http://127.0.0.1:54098/'],
    ['example.com', 'https://example.com/'], ['/docs/test', base + 'docs/test'],
    ['javascript:alert(1)', null], ['data:text/html,x', null], ['file:///C:/x', null], ['', null],
  ]) assert.equal(resolveBrowserUrl(input, base), expected)
})

test('native browser opening awaits opener and never navigates the workbench on failure', async () => {
  const { openBrowserUrl } = await navigation()
  const calls = []
  const host = { __TAURI__: { core: { invoke: async (...args) => calls.push(args) } }, open: () => assert.fail('native must not use popup') }
  await openBrowserUrl('https://example.com/', host)
  assert.deepEqual(calls, [['plugin:opener|open_url', { url: 'https://example.com/' }]])
  host.__TAURI__.core.invoke = async () => { throw new Error('permission denied') }
  await assert.rejects(openBrowserUrl('https://example.com/', host), /更新客户端|复制地址/)
  await assert.rejects(openBrowserUrl('file:///secret', host), /http/)
})

test('web opens a separate tab without exposing opener and reports popup blocking', async () => {
  const { openBrowserUrl } = await navigation()
  const popup = { opener: 'workbench', location: { replace: url => popup.url = url }, close() {} }
  let opened = false
  await openBrowserUrl('https://example.com/', { open: (url, target) => { opened = true; assert.equal(url, 'about:blank'); assert.equal(target, '_blank'); return popup } })
  assert.equal(opened, true)
  assert.equal(popup.opener, null)
  assert.equal(popup.url, 'https://example.com/')
  await assert.rejects(openBrowserUrl('https://example.com/', { open: () => null }), /拦截|复制地址/)
})

test('native URL permission is restricted to web URLs and trusted workbench origins', () => {
  const permission = JSON.parse(readFileSync('app/src-tauri/capabilities/browser-links.json', 'utf8'))
  assert.deepEqual(permission.remote.urls, ['http://127.0.0.1:8787/*', 'http://localhost:8787/*'])
  assert.deepEqual(permission.permissions, [{ identifier: 'opener:allow-open-url', allow: [{ url: 'https://*' }, { url: 'http://*' }] }])
})
