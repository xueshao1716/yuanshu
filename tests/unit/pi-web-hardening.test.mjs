import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const read = (...parts) => readFile(path.join(ROOT, ...parts), 'utf8')

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-web-hardening-'))
  try { return await fn(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

test('frontend sync mirrors source and removes stale target assets', async () => {
  const { syncFrontend } = await import('../../scripts/sync-frontend.mjs')
  await withTempDir(async dir => {
    const source = path.join(dir, 'source')
    const publicTarget = path.join(dir, 'public')
    const appTarget = path.join(dir, 'app-dist')
    await fs.mkdir(path.join(source, 'assets'), { recursive: true })
    await fs.mkdir(publicTarget, { recursive: true })
    await fs.mkdir(appTarget, { recursive: true })
    await fs.writeFile(path.join(source, 'index.html'), '<script src="/assets/new.js"></script>')
    await fs.writeFile(path.join(source, 'assets', 'new.js'), 'new')
    await fs.writeFile(path.join(publicTarget, 'index.html'), 'old')
    await fs.mkdir(path.join(publicTarget, 'assets'), { recursive: true })
    await fs.writeFile(path.join(publicTarget, 'assets', 'old.js'), 'old')
    await fs.writeFile(path.join(publicTarget, 'legacy.html'), 'keep me')
    await fs.writeFile(path.join(appTarget, 'index.html'), 'old')
    await syncFrontend({ sourceDir: source, targets: [publicTarget, appTarget], preserveTargets: [publicTarget] })
    assert.equal(await fs.readFile(path.join(publicTarget, 'index.html'), 'utf8'), '<script src="/assets/new.js"></script>')
    assert.equal(await fs.readFile(path.join(appTarget, 'assets', 'new.js'), 'utf8'), 'new')
    await assert.rejects(() => fs.access(path.join(publicTarget, 'assets', 'old.js')))
    assert.equal(await fs.readFile(path.join(publicTarget, 'legacy.html'), 'utf8'), 'keep me')
  })
})

test('Capacitor uses the single React frontend distribution', async () => {
  const src = await read('capacitor.config.ts')
  assert.match(src, /webDir:\s*['"]frontend\/dist['"]/, 'Capacitor must consume frontend/dist')
})

test('endpoint resolution uses the configured remote API base', async () => {
  const api = await read('frontend', 'src', 'api.ts')
  const sessionDb = await read('frontend', 'src', 'pages', 'SessionDb.tsx')
  const tui = await read('frontend', 'src', 'components', 'TuiTerminal.tsx')
  assert.match(api, /export function getApiBase\(/)
  assert.match(api, /export function apiUrl\(/)
  assert.match(api, /export function webSocketUrl\(/)
  assert.match(api, /fetch\(apiUrl\(path\)/)
  assert.doesNotMatch(api, /fetch\(_apiBase\s*\+/, 'all API requests must use apiUrl()')
  assert.doesNotMatch(sessionDb, /fetch\(['"]\/api\/sessions\/db/)
  assert.doesNotMatch(sessionDb, /body:\s*JSON\.stringify\(/, 'database mutations must pass objects to api()')
  assert.match(sessionDb, /import \{ api, SessionsApi(?:, RecallApi)? \} from ['"]\.\.\/api['"]/) 
  assert.match(tui, /webSocketUrl\(/)
  assert.doesNotMatch(tui, /location\.host\/ws\/tui/)
  const store = await read('frontend', 'src', 'store.tsx')
  assert.match(store, /import \{ ModelsApi, SessionsApi, setToken, getToken, setApiBase, getApiBase \} from ['"]\.\/api['"]/, 'login must update the in-memory API base')
  assert.match(store, /setApiBase\(base\)/, 'successful login must update API base before requests continue')
})

test('host binding defaults to loopback and LAN mode is explicit', () => {
  const script = "import { CONFIG } from './config.mjs'; console.log(CONFIG.host)"
  const run = env => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PI_WEB_HOST: '', PI_WEB_LAN: '', ...env },
  }).trim()
  assert.equal(run({}), '127.0.0.1')
  assert.equal(run({ PI_WEB_LAN: '1' }), '0.0.0.0')
  assert.equal(run({ PI_WEB_HOST: '192.168.1.20' }), '192.168.1.20')
})

test('CORS policy allows known shells and rejects unknown origins', async () => {
  const { createCorsPolicy } = await import('../../engine/cors-policy.mjs')
  const policy = createCorsPolicy('https://allowed.example, https://another.example/')
  assert.equal(policy.allowedOrigin('tauri://localhost'), 'tauri://localhost')
  assert.equal(policy.allowedOrigin('https://allowed.example'), 'https://allowed.example')
  assert.equal(policy.allowedOrigin('https://another.example'), 'https://another.example')
  assert.equal(policy.allowedOrigin('https://evil.example'), null)
  assert.deepEqual(policy.headers('https://allowed.example'), {
    'Access-Control-Allow-Origin': 'https://allowed.example',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  })
  assert.deepEqual(policy.headers('https://evil.example'), { Vary: 'Origin' })
})

test('session SSE uses Authorization fetch instead of query-token EventSource', async () => {
  const api = await read('frontend', 'src', 'api.ts')
  assert.match(api, /fetch\(apiUrl\(`\/api\/sessions\//, 'session stream must use fetch so it can send Authorization')
  assert.match(api, /Authorization:\s*`Bearer \$\{_token\}`/, 'session stream must authenticate with Authorization')
  assert.doesNotMatch(api, /new EventSource\(/, 'session stream must not expose token through EventSource URL')
  assert.doesNotMatch(api, /sessions\/.*stream[^`]*token=/, 'session stream URL must not contain token query parameter')
})

test('TUI WebSocket authenticates after connect instead of using a query token', async () => {
  const tui = await read('frontend', 'src', 'components', 'TuiTerminal.tsx')
  const bridge = await read('engine', 'tui-bridge.mjs')
  assert.match(tui, /new WebSocket\(webSocketUrl\(['"]\/ws\/tui['"]\)\)/, 'TUI must connect without credentials in the URL')
  assert.match(tui, /type:\s*['"]auth['"].*token/, 'TUI must send an auth handshake after connect')
  assert.match(tui, /type === ['"]auth_ok['"]/, 'TUI must wait for auth_ok before sending terminal commands')
  assert.doesNotMatch(tui, /\/ws\/tui\?token=/, 'TUI must not put the token in the WebSocket URL')
  assert.match(bridge, /d\.type !== ['"]auth['"]/, 'TUI bridge must require an auth handshake')
  assert.match(bridge, /type:\s*['"]auth_ok['"]/, 'TUI bridge must acknowledge successful authentication')
  assert.doesNotMatch(bridge, /searchParams\.get\(['"]token['"]\)/, 'TUI bridge must not authenticate from a query token')
})

test('Mermaid rendering uses strict security and rejects oversized diagrams', async () => {
  const src = await read('frontend', 'src', 'components', 'Markdown.tsx')
  assert.match(src, /securityLevel:\s*['"]strict['"]/, 'Mermaid must use strict security')
  assert.doesNotMatch(src, /securityLevel:\s*['"]loose['"]/, 'Mermaid must not use loose security')
  assert.match(src, /export function shouldRenderMermaid\(code: string\): boolean/)
  assert.match(src, /shouldRenderMermaid\(code\)/)
  assert.match(src, /MAX_MERMAID_CHARS\s*=\s*64 \* 1024/)
  assert.match(src, /code\.length\s*<=\s*MAX_MERMAID_CHARS/)
})

test('chat keeps Markdown and auxiliary panels out of the initial bundle', async () => {
  const layout = await read('frontend', 'src', 'AppLayout.tsx')
  const message = await read('frontend', 'src', 'components', 'Message.tsx')
  const workspace = await read('frontend', 'src', 'components', 'Workspace.tsx')
  assert.doesNotMatch(message, /import Markdown from ['"]\.\/Markdown['"]/, 'Message must lazy-load Markdown')
  assert.match(message, /lazy\(\(\) => import\(['"]\.\/Markdown['"]\)\)/, 'Message must dynamically load Markdown')
  assert.doesNotMatch(workspace, /import Markdown from ['"]\.\/Markdown['"]/, 'Workspace must lazy-load Markdown')
  assert.match(layout, /lazy\(\(\) => import\(['"]\.\/components\/(TuiTerminal|Workspace|TerminalPanel)['"]\)\)/, 'auxiliary panels must be dynamically loaded')
  assert.doesNotMatch(layout, /import (TuiTerminal|WorkSpace|TerminalPanel) from ['"]\.\/components\//, 'auxiliary panels must not be statically imported')
  assert.match(layout, /modelOpen && <LazyModelManager/, 'model manager must load only when opened')
})

test('HTTP responses expose the browser security baseline and redact nested errors', async () => {
  const http = await read('engine', 'http-utils.mjs')
  const server = await read('server.mjs')
  assert.match(server, /Content-Security-Policy/, 'server must send a CSP')
  assert.match(server, /fonts\.loli\.net/, 'CSP 必须放行水墨楷体用的 fonts.loli.net')
  assert.match(server, /gstatic\.loli\.net/, 'CSP 必须放行 gstatic.loli.net 字体文件')
  assert.match(server, /X-Content-Type-Options.*nosniff/, 'server must disable MIME sniffing')
  assert.match(server, /X-Frame-Options.*DENY/, 'server must deny framing')
  assert.match(server, /Referrer-Policy.*no-referrer/, 'server must avoid referrer leakage')
  assert.match(server, /Permissions-Policy/, 'server must restrict browser capabilities')
  assert.match(http, /function sanitizeError\(/, 'JSON errors must pass through a sanitizer')
  const { json } = await import('../../engine/http-utils.mjs')
  let body = ''
  const res = { writeHead() {}, end(value) { body = String(value) } }
  json(res, 502, { error: { message: 'upstream Authorization: Bearer secret-token-123456789', detail: 'apiKey=sk-secret-value-123456789' } })
  assert.doesNotMatch(body, /secret-token|sk-secret-value/, 'nested error details must not expose credentials')
  assert.match(body, /REDACTED/, 'nested error details must retain a safe placeholder')
})

test('README documents the reproducible multi-platform frontend workflow', async () => {
  const readme = await read('README.md')
  for (const term of [
    'frontend/dist', 'npm run build:mobile:web', 'YUANSHU_LAN=1',
    'zhipu-paid/glm-5.3-flash', 'arm64', 'armeabi-v7a', 'x86_64', 'universal',
    // 环境变量已从 PI_WEB_* 迁到 YUANSHU_*，但旧名仍是兼容读的；
    // 文档必须同时交代这一点，否则老安装升级后不知道自己的变量还算不算数。
    'PI_WEB_',
  ]) assert.match(readme, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README must document ${term}`)
})
