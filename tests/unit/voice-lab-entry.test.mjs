import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = name => fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8')

test('voice trial is available only on the deployed IPv4 loopback origin', async () => {
  const moduleUrl = new URL('../../frontend/src/lib/voice-lab-entry.mjs', import.meta.url)
  assert.ok(fs.existsSync(moduleUrl), 'local voice trial origin policy is implemented')
  const { voiceLabUrl } = await import(moduleUrl.href)
  assert.equal(voiceLabUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8788/')
  for (const origin of [undefined, '', 'https://pi.myxinyu.xin', 'http://192.168.1.2:8787', 'http://localhost:8787', 'http://[::1]:8787', 'http://127.0.0.1:8790', 'https://127.0.0.1:8787', 'http://127.0.0.1:8787.evil.test', 'http://127.0.0.1:8787/?token=private']) {
    assert.equal(voiceLabUrl(origin), null, String(origin))
  }
})

test('trial entry preserves isolation, blocks busy audio and silences output before opening', () => {
  const file = new URL('../../frontend/src/components/VoiceLabEntry.tsx', import.meta.url)
  assert.ok(fs.existsSync(file), 'local voice trial entry is implemented')
  const source = fs.readFileSync(file, 'utf8'), lines = source.split('\n')
  assert.ok(source.includes('if (!url) return null'))
  assert.ok(lines.some(line => line.includes('<a ') && line.includes('href={busy ? undefined : url}') && line.includes('target="_blank"') && line.includes('rel="noopener noreferrer"')))
  assert.ok(source.includes('aria-disabled={busy}') && source.includes('tabIndex={busy ? -1 : 0}'))
  const guard = source.indexOf('event.preventDefault()'), stop = source.indexOf('speech.stop()')
  assert.ok(guard > 0 && stop > guard && source.includes('if (busy)'))
  assert.ok(source.includes('setAutoSpeech(false)'))
  assert.ok(source.includes('aria-describedby=') && source.includes('独立测试会话') && source.includes('不会带入当前聊天'))
  assert.ok(source.includes('本机试用') && source.includes('新标签页'))
  assert.ok(source.includes('先结束录音或等待语音处理完成'))
  assert.ok(!source.includes('fetch(') && !source.includes('sessionId') && !source.includes('getUserMedia'))
  const sendBox = read('frontend/src/components/SendBox.tsx')
  assert.ok(!sendBox.includes('<VoiceLabEntry'), 'main chat no longer opens the isolated lab')
  assert.ok(sendBox.includes('data-voice-entry') && sendBox.includes('onClick={onOpenCall}'))
  assert.ok(sendBox.split('\n').some(line => line.includes('disabled=') && line.includes('recording || requestingMic || convertingVoice || voiceBusy || streaming')))
  assert.ok(read('frontend/src/components/ChatArea.tsx').includes('<RealtimeCall key={sessionViewKey}'))
  assert.ok(!sendBox.includes('SpeechPreference'), 'speech settings leave the composer')
  assert.ok(read('frontend/src/components/MoodPanel.tsx').includes('<SpeechSettings'), 'speech settings move into the mood panel')
  assert.ok(sendBox.indexOf('data-voice-entry') > sendBox.indexOf('className="sendbox-shell'), 'call entry belongs inside the input shell')
})
