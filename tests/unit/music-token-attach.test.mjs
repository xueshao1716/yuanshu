// 音乐流代理的鉴权（2026-10-18 初版，2026-11-13 AUTH-003 改为短时票据）。
// 背景：<audio> 带不了 Authorization 头，/api/music/stream 只能走 URL 凭据。
// 旧做法是 ?token=<长期令牌>（会进历史/日志/Referer）；现在改成 scope=stream:music 的 60 秒票据，
// 只有票据接口不可用时才降级回 ?token=。这里锁规则本身 + api.ts 的接线方式。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ticketScopeForUrl, withTicketParam } from '../../frontend/src/lib/media-ticket.ts'

const API_SRC = fs.readFileSync(new URL('../../frontend/src/api.ts', import.meta.url), 'utf8')
const TICKET_SRC = fs.readFileSync(new URL('../../frontend/src/lib/media-ticket.ts', import.meta.url), 'utf8')

test('音乐流属于 stream:music 票据 scope', () => {
  assert.equal(ticketScopeForUrl('/api/music/stream?u=abc'), 'stream:music')
  assert.equal(ticketScopeForUrl('/api/music/stream'), 'stream:music')
  assert.notEqual(ticketScopeForUrl('/api/music/stream?u=abc'), ticketScopeForUrl('/api/notify/stream'))
})

test('音乐流 URL 带票据：补全 apiBase 前缀，且不再留 token', () => {
  assert.equal(
    withTicketParam('/api/music/stream?u=abc', 'http://192.168.1.5:8787', 'T1'),
    'http://192.168.1.5:8787/api/music/stream?u=abc&ticket=T1',
  )
  const upgraded = withTicketParam('/api/music/stream?u=abc&token=old', '', 'T2')
  assert.equal(upgraded, '/api/music/stream?u=abc&ticket=T2')
  assert.equal(new URL(upgraded, 'http://x').searchParams.has('token'), false)
})

test('非音乐/非媒体路径不受影响（不误伤图片/视频/普通接口）', () => {
  assert.equal(ticketScopeForUrl('/api/ws/file?path=a.mp3'), 'file:')
  assert.equal(ticketScopeForUrl('https://cdn.example.com/a.mp3'), '')
  assert.equal(ticketScopeForUrl('/api/sessions'), '')
})

test('api.ts 的 withFileToken 走票据，音乐流的旧 ?token= 只作为降级保留', () => {
  assert.match(API_SRC, /function withFileToken/)
  assert.match(API_SRC, /const ticket = _mediaTickets\.sync\(scope\)/)
  assert.match(API_SRC, /withTicketParam\(url, getApiBase\(\), ticket\)/)
  assert.match(API_SRC, /legacyMediaUrl\(url, scope\)/, '没有票据时才降级')
  assert.match(API_SRC, /token=\$\{encodeURIComponent\(_token\)\}/, '降级仍要能拼旧 token（老后端不裂）')
  assert.match(TICKET_SRC, /\/\^\\\/api\\\/\(\[A-Za-z0-9_-\]\+\)\\\/stream\$/, '流式路径的 scope 推导必须还在')
})
