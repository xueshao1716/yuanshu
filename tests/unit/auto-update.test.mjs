// 小更新静默装、大更新才提醒（2026-11-23）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isImportant, fetchRemoteMeta, createAutoUpdater, runsIdle, applyViaHandler } from '../../engine/auto-update.mjs'

test('isImportant：远端 notify 比本机新才算大更新；读不到远端按大更新', () => {
  assert.equal(isImportant('2.228.0', { version: '2.228.3', notify: '2.228.0' }), false)
  assert.equal(isImportant('2.228.0', { version: '2.229.0', notify: '2.229.0' }), true)
  assert.equal(isImportant('2.228.0', { version: '2.228.1', notify: '' }), false)
  assert.equal(isImportant('2.228.0', null), true)
})

test('fetchRemoteMeta：第一个源失败换第二个', async () => {
  let n = 0
  const fetchImpl = async () => (++n === 1 ? { ok: false } : { ok: true, json: async () => ({ version: '2.229.0', notify: '2.229.0' }) })
  assert.deepEqual(await fetchRemoteMeta(fetchImpl, ['a', 'b']), { version: '2.229.0', notify: '2.229.0' })
})

const behind = (extra = {}) => async () => ({ ok: true, upToDate: false, relation: 'behind', important: false, ...extra })

test('自动更新：小更新等到空闲才装', async () => {
  let idle = false, applied = 0
  const u = createAutoUpdater({ check: behind(), apply: async () => { applied++; return { ok: true } }, isIdle: () => idle, env: {} })
  assert.equal((await u.tick()).skipped, 'not-idle')
  assert.equal(applied, 0)
  idle = true
  assert.equal((await u.tick()).applied, true)
  assert.equal(applied, 1)
})

test('自动更新：大更新、分叉、开发机改动、关掉开关都不自动装', async () => {
  const apply = async () => { throw new Error('不该装') }
  const idle = () => true
  assert.equal((await createAutoUpdater({ check: behind({ important: true }), apply, isIdle: idle, env: {} }).tick()).skipped, 'important')
  assert.equal((await createAutoUpdater({ check: behind({ relation: 'diverged' }), apply, isIdle: idle, env: {} }).tick()).skipped, 'relation-diverged')
  assert.equal((await createAutoUpdater({ check: behind(), apply, isIdle: idle, dirty: async () => true, env: {} }).tick()).skipped, 'dirty')
  assert.equal((await createAutoUpdater({ check: behind(), apply, isIdle: idle, env: { YUANSHU_AUTO_UPDATE: '0' } }).tick()).skipped, 'disabled')
})

test('runsIdle：有对话在跑或刚结束都不算空闲', () => {
  const now = Date.parse('2026-11-23T10:00:00Z')
  assert.equal(runsIdle([{ status: 'running' }], { now }), false)
  assert.equal(runsIdle([{ status: 'completed', updatedAt: '2026-11-23T09:55:00Z' }], { now }), false)
  assert.equal(runsIdle([{ status: 'completed', updatedAt: '2026-11-23T09:40:00Z' }], { now }), true)
})

test('applyViaHandler：拿回处理器的结果', async () => {
  const ok = await applyViaHandler(async res => { res.writeHead(200); res.end(JSON.stringify({ ok: true, message: 'm' })) })
  assert.deepEqual(ok, { ok: true, message: 'm' })
  const bad = await applyViaHandler(async res => { res.writeHead(409); res.end(JSON.stringify({ error: '忙' })) })
  assert.deepEqual(bad, { ok: false, error: '忙' })
})

test('界面：小更新不弹窗，手机 App 小版本只在「更多」里给入口', () => {
  const notice = readFileSync(new URL('../../frontend/src/components/shell/UpdateNotice.tsx', import.meta.url), 'utf8')
  assert.match(notice, /result\?\.important === false && result\?\.relation === 'behind'/)
  const apk = readFileSync(new URL('../../frontend/src/components/shell/AppUpdateNotice.tsx', import.meta.url), 'utf8')
  assert.match(apk, /if \(!r\.notify \|\| !newerVersion\(r\.notify, mine\)\) return/)
  const menu = readFileSync(new URL('../../frontend/src/components/shell/MobileMoreMenu.tsx', import.meta.url), 'utf8')
  assert.match(menu, /<span>安装新版 App<\/span>/)
})
