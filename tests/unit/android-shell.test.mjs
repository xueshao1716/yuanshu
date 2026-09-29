import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mobileApiBaseError, isBundledShellOrigin } from '../../frontend/src/lib/shell-origin.ts'
import { createCorsPolicy } from '../../engine/cors-policy.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

test('Tauri Android WebView 的 https://tauri.localhost 必须在 CORS 白名单', () => {
  const policy = createCorsPolicy('')
  assert.equal(policy.allowedOrigin('https://tauri.localhost'), 'https://tauri.localhost')
})

test('内置壳不能把 127.0.0.1 当服务器，否则会话打到手机自己', () => {
  assert.equal(isBundledShellOrigin('https://tauri.localhost'), true)
  assert.ok(mobileApiBaseError('', 'https://tauri.localhost'))
  assert.ok(mobileApiBaseError('http://127.0.0.1:8787', 'https://tauri.localhost'))
  assert.equal(mobileApiBaseError('https://pi.example.com', 'https://tauri.localhost'), '')
  assert.equal(mobileApiBaseError('', 'http://127.0.0.1:8787'), '')
})

test('登录页在手机壳上必须要求填写远程地址', () => {
  const login = read('frontend', 'src', 'components', 'Login.tsx')
  assert.ok(login.includes('mobileApiBaseError'), '登录必须校验手机壳的服务器地址')
  assert.ok(login.includes('https://example.com'), '占位符要给出通用公网入口示例')
  const store = read('frontend', 'src', 'store.tsx')
  assert.ok(store.includes('mobileApiBaseError'), '有令牌但没有可用服务器时不得进主界面')
  assert.ok(store.includes('pi_api_base'), '退出登录必须清掉服务器地址，避免幽灵空会话')
})

test('Android 正式包允许明文 HTTP，才能连电脑局域网 8787', () => {
  const gradle = read('app', 'src-tauri', 'gen', 'android', 'app', 'build.gradle.kts')
  const defaultBlock = gradle.slice(gradle.indexOf('defaultConfig'), gradle.indexOf('buildTypes'))
  assert.match(defaultBlock, /usesCleartextTraffic"\]\s*=\s*"true"/, 'release 默认也必须放行 HTTP')
})

test('Android 首屏使用不绑定私人域名的 HTTPS 包内连接页', () => {
  const src = read('app', 'src-tauri', 'src', 'lib.rs')
  const mobile = src.slice(src.indexOf('#[cfg(mobile)]'))
  assert.ok(mobile.includes('WebviewUrl::App("connect.html".into())'))
  assert.ok(mobile.includes('.use_https_scheme(true)'), '禁止退回旧 HTTP 自定义协议入口')
  const capability = JSON.parse(read('app', 'src-tauri', 'capabilities', 'remote-piweb.json'))
  assert.ok(capability.remote.urls.every(url => /^http:\/\/(127\.0\.0\.1|localhost):8787(?:\/\*)?$/.test(url)))
})

test('手机连接页只接受远程 HTTP(S) origin，不接受令牌或路径', async () => {
  const { normalizeWorkspaceUrl } = await import('../../app/startup/connect.mjs')
  assert.equal(normalizeWorkspaceUrl('https://work.example.test/'), 'https://work.example.test/')
  assert.equal(normalizeWorkspaceUrl('http://192.168.1.20:8787'), 'http://192.168.1.20:8787/')
  for (const value of ['', 'javascript:alert(1)', 'https://u:p@example.test', 'https://example.test/?token=x', 'http://localhost:8787', 'http://127.0.0.1:8787', 'https://example.test/path']) {
    assert.throws(() => normalizeWorkspaceUrl(value), undefined, value)
  }
})

test('元枢壳版本号必须高于 0.1.0，覆盖安装才会换原生代码', () => {
  // 不再写死具体数字——版本唯一来源是 version.json，写死就等于每次发版都要来改测试，
  // 以前就是这么漂的。这里只锁**功能性质**：壳版本必须 > 0.1.0，
  // 否则安卓覆盖安装不会替换原生代码（这是当初升到 0.2.x 的原因）。
  const { version } = JSON.parse(read('version.json'))
  const conf = JSON.parse(read('app', 'src-tauri', 'tauri.conf.json'))
  const cargo = read('app', 'src-tauri', 'Cargo.toml')
  assert.equal(conf.version, version, 'tauri.conf.json 必须与 version.json 同版本')
  assert.match(cargo, new RegExp(`^version = "${version.replace(/\./g, '\\.')}"`, 'm'), 'Cargo.toml 必须与 version.json 同版本')
  const [major, minor] = version.split('.').map(Number)
  assert.ok(major > 0 || minor > 1, `壳版本 ${version} 必须高于 0.1.0，否则覆盖安装换不掉原生代码`)
})
