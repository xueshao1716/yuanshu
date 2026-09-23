import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeMessages } from '../../frontend/src/lib/local-db.ts'
import { cleanLegacyReferenceCache } from '../../frontend/src/lib/legacy-media-cache.ts'

const url = '/api/ws/file?path=' + encodeURIComponent('生成物/old.png')
const video = '/api/ws/file?path=' + encodeURIComponent('生成物/old.mp4')
const tool = { id: 'read-1', name: 'read', output: '参考 生成物/old.png 和 生成物/old.mp4' }
const base = { id: 'a', sessionId: 's', role: 'assistant', text: '当前任务完成', ts: '2026-09-23T01:00:00Z', draft: false, synced: true }

test('只有最终正文的旧历史也能凭已完成的本轮工具记录清理参考缓存', () => {
  const local = { ...base, tools: [tool], images: [url, '/unknown.png'], videos: [video] }
  const clean = cleanLegacyReferenceCache(local)
  assert.deepEqual(clean.images, ['/unknown.png'])
  assert.deepEqual(clean.videos, [])
  assert.equal(local.images.length, 2)
})

test('本地清理保留生成结果、下载交付、文件附件、草稿和未知来源', () => {
  const make = extra => ({ ...base, images: [url], tools: [tool], ...extra })
  for (const extra of [
    { tools: [tool, { id: 'g', name: 'generate_image', output: url, isError: false }] },
    { tools: [tool, { id: 'd', name: 'bash', args: { command: 'curl -o 生成物/old.png https://example.org/image.png' }, output: '下载完成', isError: false }] },
    { files: [{ path: '生成物/old.png' }] }, { draft: true }, { streaming: true },
    { text: '交付 生成物/old.png' }, { tools: [] },
  ]) assert.deepEqual(cleanLegacyReferenceCache(make(extra)).images, [url])
})

test('已完成缓存只清理同一工具已确认的参考附件，保留当前生成图', () => {
  const local = { ...base, images: [url + '&sig=old', '/current.png'], videos: [video], tools: [tool] }
  const server = { ...base, images: ['/current.png'], tools: [tool] }
  const [merged] = mergeMessages([local], [server])
  assert.deepEqual(merged.images, ['/current.png'])
  assert.deepEqual(merged.videos, [])
  assert.equal(local.images.length, 2, '不修改原始输入/审计数据')
})

test('缓存能识别单纯查阅经验库的bash，但不靠任意bash路径删除媒体', () => {
  for (const [command, removed] of [
    ['cd /d/pi-workspace && tail -20 工程/经验库/experience.md', true],
    ['grep -n 比例 工程/经验库/experience.md | head -20', true],
    ['cd /d/pi-workspace && grep -n "2:3\\|比例" 工程/经验库/experience.md | head', true],
    ['curl https://example.com/i.png -o 生成物/old.png', false],
    ['node draw.mjs', false],
    ['cat <(node draw.mjs)', false],
  ]) {
    const t = { ...tool, name: 'bash', args: { command } }
    const [merged] = mergeMessages([{ ...base, tools: [t], images: [url] }], [{ ...base, tools: [t] }])
    assert.equal(merged.images.length, removed ? 0 : 1, command)
  }
})

test('未完成缓存、用户上传、显式正文交付、服务端附件、无共同工具ID一律保留', () => {
  for (const overrides of [{ draft: true }, { streaming: true }, { role: 'user' }, { text: `请看 ![图片](${url})` }]) {
    const local = { ...base, tools: [tool], images: [url], ...overrides }
    assert.deepEqual(mergeMessages([local], [{ ...base, role: local.role, tools: [tool] }])[0].images, [url])
  }
  assert.deepEqual(mergeMessages([{ ...base, tools: [tool], images: [url] }], [{ ...base, tools: [tool], images: [url] }])[0].images, [url])
  assert.deepEqual(mergeMessages([{ ...base, tools: [tool], images: [url] }], [{ ...base, tools: [{ ...tool, id: 'different' }] }])[0].images, [url])
})

test('后台读取和生成混合命令不是只读，不能清理其媒体缓存', () => {
  const t = { ...tool, name: 'bash', args: { command: 'cat reference.md & node draw.mjs' } }
  const local = { ...base, tools: [t], images: [url] }
  assert.deepEqual(cleanLegacyReferenceCache(local).images, [url])
  assert.deepEqual(mergeMessages([local], [{ ...base, tools: [t] }])[0].images, [url])
})
