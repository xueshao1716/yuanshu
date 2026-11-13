// ════════════════════════════════════════════════════════════
// 同一条消息里同一张图只渲染一次（2026-11-13 真机现象）
//
// 现象：新会话里"一张大图 + 一张小尺寸的"——同一张图被两套渲染器各画一次：
//   · 正文 markdown 的 ![](/api/ws/file?path=…)（自然尺寸，撑满正文宽度）
//   · 媒体块 Attachments 的 msg.images（max-w-[320px] max-h-[280px] 缩略）
// 根因：服务端把附件块改写成 `![图片](url)` 落盘（sdkSafeAssistantBlocks），
//      读回时 extractImages 又按 markdown 把**同一张图**抠进 msg.images。
// 所以判重不能按整条 URL（exp/sig/token 每次都变），只能按本地路径。
//
// 跑法：cd frontend && node --test tests/
// ════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectShownImageKeys, isImageShownByMedia, mediaPathKey } from '../src/lib/media-embed.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(ROOT, p), 'utf8')

// 真实值（2026-11-13 22:48 那条会话落盘的文件名）。
const FILE = '生成物\\图片\\2026-11-13\\【小语自画像】小语_图片_20261113-224910-126-368860c8_v2.214.0.png'
const ENC = encodeURIComponent(FILE)
// 媒体块 src（服务端 media 事件 / msg.images）
const mediaSrc = `/api/ws/file?path=${ENC}&exp=1794667750950&sig=bca3c5b5c6c5b327`
// 正文 markdown src（落盘时写进 text 的那一条）
const textSrc = `/api/ws/file?path=${ENC}&exp=1794667750950&sig=bca3c5b5c6c5b327`

test('同一张图：正文 markdown 与媒体块归一后是同一把键', () => {
  assert.equal(mediaPathKey(mediaSrc), mediaPathKey(textSrc))
  // 票据/token/版本号都是签名参数，换一次不该变成"另一张图"
  const other = [
    `${mediaSrc}&token=legacy-token`,
    `/api/ws/file?path=${ENC}&ticket=abc123`,
    `/api/ws/file?path=${ENC}&exp=1&sig=2&v=3`,
    `D:\\pi-workspace\\${FILE}`,
    FILE.replace(/\\/g, '/'),
  ]
  for (const url of other) {
    assert.equal(mediaPathKey(url), mediaPathKey(mediaSrc), `应视为同一张图: ${url}`)
  }
})

test('媒体块已展示 → 正文同路径图不再渲染（只留「图片见下」）', () => {
  const keys = collectShownImageKeys([mediaSrc])
  assert.equal(keys.size, 1)
  for (const src of [textSrc, `/api/ws/file?path=${ENC}&ticket=zzz`, `D:\\pi-workspace\\${FILE}`, FILE.replace(/\\/g, '/')]) {
    assert.equal(isImageShownByMedia(src, keys), true, `正文这张图必须让位给媒体块: ${src}`)
  }
})

test('不同文件不误杀：媒体块与正文各画各的', () => {
  const keys = collectShownImageKeys([mediaSrc])
  const another = [
    `/api/ws/file?path=${encodeURIComponent('生成物\\图片\\2026-11-13\\另一张图.png')}`,
    `/api/ws/file?path=${encodeURIComponent(FILE.replace('2026-11-13', '2026-11-12'))}`,
    'D:\\pi-workspace\\生成物\\图片\\2026-11-13\\同一目录另一张.png',
  ]
  for (const src of another) {
    assert.equal(isImageShownByMedia(src, keys), false, `不同文件不能删: ${src}`)
  }
})

test('远端图不参与媒体块去重：仍然走「外链图未归档」', () => {
  const remote = 'https://images.example.com/generated/image.png'
  assert.equal(collectShownImageKeys([remote]).size, 0, '远端地址不能进媒体块去重集合')
  assert.equal(isImageShownByMedia(remote, collectShownImageKeys([mediaSrc])), false, '远端图永远不由本地媒体块顶替')
  // 反过来：远端图在媒体块里（旧会话），也不能让本地正文图消失
  assert.equal(isImageShownByMedia(mediaSrc, collectShownImageKeys([remote])), false)
})

test('一条消息：媒体块 1 张 + 正文同路径 markdown 2 张 → 只渲染 1 张', () => {
  // 落盘形态实测：正文里同一张图可能出现两遍（模型回显 + 附件块改写），
  // 媒体块再算一张，旧代码一共画 3 张。
  const text = `画好了：\n\n![图片](${textSrc})\n\n就是这张。\n\n![图片](${textSrc})\n`
  const keys = collectShownImageKeys([mediaSrc])
  const markdownImages = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map(m => m[1])
  assert.equal(markdownImages.length, 2)
  const stillRendered = markdownImages.filter(src => !isImageShownByMedia(src, keys))
  assert.deepEqual(stillRendered, [], '正文里的重复图全部让位')
  const rendered = stillRendered.length + (keys.size ? 1 : 0)
  assert.equal(rendered, 1, '整条消息只剩媒体块那一张')
})

test('正文存在别的图时照常显示（媒体块只认自己的那张）', () => {
  const other = `/api/ws/file?path=${encodeURIComponent('生成物\\图片\\2026-11-13\\参考图.png')}`
  const keys = collectShownImageKeys([mediaSrc])
  assert.equal(isImageShownByMedia(other, keys), false)
  assert.equal(isImageShownByMedia(mediaSrc, collectShownImageKeys([other])), false)
})

// ── 源码契约：组件真的用了这套判据，且远端兜底没被改坏 ──
test('Markdown.tsx：媒体块去重在 <img> 之前，外链文案保持原样', () => {
  const src = read('src/components/chat/Markdown.tsx')
  const remoteAt = src.indexOf('（外链图未归档）')
  const dedupeAt = src.indexOf('isImageShownByMedia(src, shownImageKeys)')
  const imgAt = src.indexOf('return <img src={finalSrc}')
  assert.ok(remoteAt > 0, '外链图兜底文案不能丢')
  assert.ok(dedupeAt > remoteAt, '远端判定必须先于媒体块去重（外链图仍有文字链接）')
  assert.ok(imgAt > dedupeAt, '去重判定必须在真正 <img> 之前')
  assert.match(src, /data-image-dedupe="media"/, '去重占位要可断言')
  assert.match(src, /〔图片见下〕/, '正文降级成一行指引')
  assert.match(src, /shownImageKeys\?: ReadonlySet<string>/, '组件接收媒体块图片键')
})

test('Message.tsx：媒体块键来自 msg.images，正文渲染时传下去', () => {
  const src = read('src/components/chat/Message.tsx')
  assert.match(src, /collectShownImageKeys\(msg\.images\)/, '键必须来自本条消息的媒体块')
  const passes = src.match(/<LazyMarkdown text=\{msg\.(?:text|conclusion)\} shownImageKeys=\{shownImageKeys\}/g) || []
  assert.ok(passes.length >= 3, `三处正文渲染都要传（text / conclusion），实际 ${passes.length}`)
  // 媒体块仍在正文下面（"图片见下"才成立）。user 气泡里也有一个 <Attachments>（在正文上面），
  // 所以取最后一个 = assistant 的那个。
  assert.ok(src.lastIndexOf('<Attachments msg={msg} />') > src.indexOf('LazyMarkdown text={msg.text} shownImageKeys'))
})
