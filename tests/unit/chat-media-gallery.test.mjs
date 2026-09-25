import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('gallery orders same-session attachments and deduplicates renewed file signatures', async () => {
  const { collectChatMedia } = await import('../../frontend/src/lib/chat-media.ts')
  const messages = [
    { sessionId: 'a', images: ['/api/ws/file?path=a.png&sig=old'], videos: ['/api/ws/file?path=b.mp4'] },
    { sessionId: 'b', images: ['/api/ws/file?path=private.png'] },
    { sessionId: 'a', images: ['/api/ws/file?path=a.png&sig=new', '/api/ws/file?path=c.png'] },
  ]
  assert.deepEqual(collectChatMedia(messages, 'a').map(m => [m.kind, m.name]), [['image', 'a.png'], ['video', 'b.mp4'], ['image', 'c.png']])
  assert.deepEqual(collectChatMedia(messages, ''), [])
})

test('filenames preserve Chinese extensions and query order; malformed escapes do not block saving', async () => {
  const { mediaFilename } = await import('../../frontend/src/lib/chat-media.ts')
  assert.equal(mediaFilename('/api/ws/file?token=x&path=%E5%9B%BE%2F%E6%B5%B7%E6%8A%A5.png', 'image'), '海报.png')
  assert.equal(mediaFilename('https://cdn.example/film.mp4?sig=x', 'video'), 'film.mp4')
  assert.equal(mediaFilename('https://cdn.example/%oops.png', 'image'), '%oops.png')
  assert.match(mediaFilename('blob:random', 'video'), /\.mp4$/)
})

test('swipes distinguish horizontal navigation from vertical dismissal and small movements', async () => {
  const { mediaSwipe } = await import('../../frontend/src/lib/chat-media.ts')
  assert.equal(mediaSwipe(-100, 15), 'next')
  assert.equal(mediaSwipe(100, 15), 'previous')
  assert.equal(mediaSwipe(10, 120), 'close')
  assert.equal(mediaSwipe(20, 20), null)
  assert.equal(mediaSwipe(100, 95), null)
})

test('chat owns one session-keyed gallery, video and image attachments share its opener', () => {
  const chat = readFileSync('frontend/src/components/ChatArea.tsx', 'utf8')
  const message = readFileSync('frontend/src/components/Message.tsx', 'utf8')
  assert.ok(chat.includes('<ChatMediaProvider key={currentSessionId'))
  assert.ok(message.includes("openMedia(src, 'image')"))
  assert.ok(message.includes("openMedia(url, 'video')"))
})
