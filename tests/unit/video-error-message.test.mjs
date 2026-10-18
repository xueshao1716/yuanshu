// 视频错误话术（2026-10-18）。
// 真机：agnes 返回 503 video_queue_full，原样甩 JSON 用户看不懂也不知道该等还是改参数。
import test from 'node:test'
import assert from 'node:assert/strict'
import { explainVideoHttp } from '../../engine/media-api.mjs'

test('队列满翻译成「等一会儿再点」，并说明不是参数问题', () => {
  const text = explainVideoHttp(503, '{"code":"video_queue_full","message":"video queue is full, please retry later"}')
  assert.match(text, /排队已满/)
  assert.match(text, /不是参数问题/)
  assert.doesNotMatch(text, /video_queue_full/, '不要把上游原始 code 甩给用户')
})

test('大小写/变体也能识别', () => {
  assert.match(explainVideoHttp(503, 'Video Queue Is Full'), /排队已满/)
})

test('网关超时仍是原来的话术', () => {
  assert.match(explainVideoHttp(524, ''), /网关超时/)
  assert.match(explainVideoHttp(504, 'x'), /网关超时/)
})

test('其他错误保留状态码与前缀，便于排查', () => {
  const text = explainVideoHttp(400, 'invalid prompt')
  assert.match(text, /400/)
  assert.match(text, /invalid prompt/)
})
