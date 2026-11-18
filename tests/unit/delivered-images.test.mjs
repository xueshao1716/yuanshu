import test from 'node:test'
import assert from 'node:assert/strict'

import { deliveredImagesFromText } from '../../engine/media/embed.mjs'

const ws = 'D:\pi-workspace'
const exists = file => file.endsWith('A.png') || file.endsWith('B.png')

test('📎 交付的本地图片转成图片媒体，括号里的字节数和反引号不影响', () => {
  const text = '两张都好了\n📎 交付: 生成物/图片/A.png（1633759 B）\n📎 交付: `生成物/图片/B.png`'
  assert.deepEqual(deliveredImagesFromText(text, ws, { exists }).map(m => m.url), [
    '/api/ws/file?path=' + encodeURIComponent('生成物/图片/A.png'),
    '/api/ws/file?path=' + encodeURIComponent('生成物/图片/B.png'),
  ])
})

test('不存在的文件、非图片、正文里顺口提到的路径都不发', () => {
  const text = '见 生成物/图片/A.png\n📎 交付: 生成物/图片/C.png\n📎 交付: 工程/x/index.html'
  assert.deepEqual(deliveredImagesFromText(text, ws, { exists }), [])
})

test('同一张图交付两次只发一次', () => {
  const text = '📎 交付: 生成物/图片/A.png\n📎 交付: D:\pi-workspace\生成物\图片\A.png'
  assert.equal(deliveredImagesFromText(text, ws, { exists }).length, 1)
})
