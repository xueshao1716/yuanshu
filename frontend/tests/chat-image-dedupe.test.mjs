// ════════════════════════════════════════════════════════════
// 同一条消息里同一张图只渲染一次（2026-11-13 反转版）
//
// 现象没变：服务端把附件块改写成 `![图片](url)` 落盘（sdkSafeAssistantBlocks），
// 读回时 extractImages 又按 markdown 把**同一张图**抠进 msg.images，于是
// 「正文 markdown 图」和「媒体块缩略图」两套渲染器各画一次。
//
// 但取舍反过来了（用户原话："大图吧，好不好看一目了然，缩略图也得加工"）：
//   · 上一版：保留媒体块 320×280 缩略图，把正文大图折叠成「图片见下」。
//   · 这一版：正文 markdown 正常画大图（max-w-full），媒体块遇到同一张就跳过缩略图。
//
// 判重仍按本地路径（mediaPathKey），忽略 exp/sig/ticket 等签名参数；
// 正文里只认 markdown 图片语法——裸路径只是文字说明，不等于"已经画过"。
//
// 跑法：cd frontend && node --test tests/chat-image-dedupe.test.mjs
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
// 正文 markdown 里那一条（落盘时写进 text 的地址）
const bodySrc = `/api/ws/file?path=${ENC}&exp=1794667750950&sig=bca3c5b5c6c5b327`
// 媒体块 msg.images 里那一条：同一张图，签名/票据是另一套
const mediaSrc = `/api/ws/file?path=${ENC}&ticket=fresh-ticket-9f2`
const otherFile = '生成物\\图片\\2026-11-13\\参考图.png'
const otherSrc = `/api/ws/file?path=${encodeURIComponent(otherFile)}`

const MESSAGE = read('src/components/chat/Message.tsx')
const MARKDOWN = read('src/components/chat/Markdown.tsx')

// 正文图提取的真源在 Message.tsx（BODY_IMAGE）。测试直接用那份正则跑，
// 不在这里另抄一套——两套规则漂移过一次，就是因为判重逻辑各写各的。
const bodyImagePattern = MESSAGE.match(/^const BODY_IMAGE = (.+)$/m)?.[1]
const BODY_IMAGE = new Function(`return ${bodyImagePattern}`)()
const bodyImageSrcs = (...texts) =>
  texts.flatMap(text => [...String(text || '').matchAll(BODY_IMAGE)].map(match => match[1]))

// 复刻组件决策（Message.tsx 里的两行）：正文照画 markdown 图；媒体块只画正文没画过的。
// 用户消息正文是纯文本，不做让位。
function renderImageLayer({ role = 'assistant', text = '', conclusion = '', images = [] } = {}) {
  const body = bodyImageSrcs(text, conclusion)
  const keys = role === 'user' ? new Set() : collectShownImageKeys(body)
  const thumbs = images.filter(src => !isImageShownByMedia(src, keys))
  return { body, thumbs, total: body.length + thumbs.length }
}

test('同一张图：正文画 1 张大图、媒体块 0 张缩略图，整条消息 1 张', () => {
  const text = `画好了：\n\n![图片](${bodySrc})\n\n就是这张。`
  const result = renderImageLayer({ text, images: [mediaSrc] })
  assert.equal(result.body.length, 1, '正文 markdown 的大图必须照常画')
  assert.deepEqual(result.thumbs, [], '同一张图不再进媒体块缩略图')
  assert.equal(result.total, 1, '整条消息只有正文那一张')
  // 签名/票据/版本号换了还是同一张：判重只按本地路径
  const resigned = [
    `${mediaSrc}&token=legacy-token`,
    `/api/ws/file?path=${ENC}&exp=1&sig=2&v=3`,
    `D:\\pi-workspace\\${FILE}`,
    FILE.replace(/\\/g, '/'),
  ]
  for (const src of resigned) {
    assert.equal(mediaPathKey(src), mediaPathKey(bodySrc), `应视为同一张图: ${src}`)
    assert.equal(renderImageLayer({ text, images: [src] }).total, 1, `换签名不该多画一张: ${src}`)
  }
})

test('正文两张同图（模型回显 + 附件块改写）：媒体块 0 张，总数 2', () => {
  // 正文里写了两遍就是两遍——旧版会把两张都折叠成「图片见下」，
  // 现在按"正文说了算"，媒体块不再补第三张。
  const text = `画好了：\n\n![图片](${bodySrc})\n\n![图片](${mediaSrc})\n`
  const result = renderImageLayer({ text, images: [mediaSrc] })
  assert.equal(result.body.length, 2)
  assert.equal(result.thumbs.length, 0)
  assert.equal(result.total, 2)
})

test('不同路径：正文画正文的，媒体块画媒体块的', () => {
  const text = `参考图：\n\n![参考图](${otherSrc})`
  const result = renderImageLayer({ text, images: [mediaSrc] })
  assert.deepEqual(result.body, [otherSrc])
  assert.deepEqual(result.thumbs, [mediaSrc])
  assert.equal(result.total, 2, '两张不同的图都要留下')
})

test('只提到裸路径不算"画过"：媒体块照旧补缩略图', () => {
  // 正文只写了路径（没写成 ![..](..)）时，屏幕上并没有大图，缩略图就是唯一可见的。
  const text = `文件在：D:\\pi-workspace\\${FILE}`
  const result = renderImageLayer({ text, images: [mediaSrc] })
  assert.deepEqual(result.body, [])
  assert.deepEqual(result.thumbs, [mediaSrc])
})

test('用户消息不让位：正文是纯文本，附件缩略图照画', () => {
  const result = renderImageLayer({ role: 'user', text: `看这张 ![图片](${bodySrc})`, images: [mediaSrc] })
  assert.equal(result.body.length, 1) // 纯文本里不会真的画图
  assert.deepEqual(result.thumbs, [mediaSrc], '用户消息的图都在媒体块里，不能被判重吃掉')
})

test('远端图：仍走「外链图未归档」，也不参与本地路径判重', () => {
  const remote = 'https://images.example.com/generated/image.png'
  assert.equal(collectShownImageKeys([remote]).size, 0, '远端地址永远不进路径键集合')
  assert.equal(isImageShownByMedia(remote, collectShownImageKeys([mediaSrc])), false, '远端图不由本地正文顶替')
  // 正文里的远端图不会变成 <img>（只渲染一行文字 + 原链接），所以媒体块那份缩略图保留；
  // 判重在这里不能顺手把远端图也删了，否则旧会话里就彻底看不见这张图了。
  assert.equal(renderImageLayer({ text: `![远端](${remote})`, images: [remote] }).thumbs.length, 1)
  assert.match(MARKDOWN, /（外链图未归档）/, '外链图文案保持原样')
  assert.ok(MARKDOWN.indexOf('（外链图未归档）') < MARKDOWN.indexOf('return <img src={finalSrc}'), '远端判定仍然先于本地画图')
})

test('非图片附件不受影响：视频/音频/文件照旧渲染', () => {
  const attachments = MESSAGE.slice(MESSAGE.indexOf('function Attachments'), MESSAGE.indexOf('export default function Message'))
  assert.ok(attachments.includes('msg.images?.filter(src => !isImageShownByMedia(src, bodyImageKeys))'), '只过滤图片')
  assert.ok(attachments.includes('<audio controls'), '音频仍渲染')
  assert.ok(attachments.includes('<video controls'), '视频仍渲染')
  assert.ok(attachments.includes('msg.files?.map'), '文件附件仍渲染')
  assert.ok(attachments.includes("openMedia(url, 'video')"), '视频全屏入口仍在')
  assert.match(attachments, /下载视频|videoLabel/, '尺寸/名称说明文字仍在')
})

// ── 源码契约：组件真的按这个方向接的 ──
test('Message.tsx：正文提键来自 text/conclusion，媒体块跳过同路径缩略图', () => {
  assert.ok(bodyImagePattern, '正文图提取的 BODY_IMAGE 必须留在 Message.tsx（测试直接跑它）')
  assert.match(MESSAGE, /collectShownImageKeys\(bodyImageSrcs\(msg\.text, msg\.conclusion\)\)/, '键必须来自本条消息的正文')
  assert.match(MESSAGE, /msg\.role === 'user' \? new Set<string>\(\)/, '用户消息不让位')
  assert.ok(MESSAGE.includes('msg.images?.filter(src => !isImageShownByMedia(src, bodyImageKeys))'), '媒体块按正文键过滤')
})

test('正文重新变成大图：不再传媒体块键，Markdown 的「图片见下」走不到了', () => {
  assert.doesNotMatch(MESSAGE, /shownImageKeys=/, '不再把媒体块键传给 markdown')
  assert.ok(MESSAGE.includes('<LazyMarkdown text={msg.text}'), '正文 text 照常渲染')
  assert.ok(MESSAGE.includes('<LazyMarkdown text={msg.conclusion}'), '结论段照常渲染')
  assert.match(MARKDOWN, /return <img src=\{finalSrc\}[^>]*max-w-full/, '本地图按正文宽度画大图')
})

test('正文大图能点开全屏：复用媒体块那套查看器', () => {
  assert.ok(MESSAGE.includes("const { openMedia: openBodyMedia, viewerNode: bodyViewerNode } = useMediaViewer()"), '正文与媒体块共用查看器')
  assert.match(MESSAGE, /const openBodyImage = \(event: ReactMouseEvent<HTMLDivElement>\)/, '正文容器接点击')
  assert.ok(MESSAGE.includes("openBodyMedia(src, 'image')"), '点 img 交给同一个 openMedia')
  assert.equal((MESSAGE.match(/onClick=\{openBodyImage\}/g) || []).length, 3, '三段正文（text/conclusion）都要接')
  assert.match(MESSAGE, /\[&_img\]:cursor-zoom-in/, '大图要有可点的光标提示')
  assert.ok(MESSAGE.includes('{bodyViewerNode}'), '查看器节点要挂上')
  assert.ok(MESSAGE.includes("openMedia(src, 'image')"), '媒体块缩略图的入口还在')
})
