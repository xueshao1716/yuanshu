// 前端结构测试（nomifun *.structure.test.ts 模式，2026-08-25）
// 断言关键交互契约在源码中存在且顺序正确——比口头约定/review 可靠。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FE = join(ROOT, 'frontend', 'src')
const read = (...p) => readFileSync(join(FE, ...p), 'utf8')

test('结构：Markdown 自定义块必须包 SafeBlock 错误隔离（mermaid/dsh-ui/高亮代码）', () => {
  const src = read('components', 'Markdown.tsx')
  const safeCount = (src.match(/<SafeBlock/g) || []).length
  assert.ok(safeCount >= 3, `SafeBlock 应包裹 ≥3 条自定义渲染路径，实际 ${safeCount}`)
  for (const marker of ['MermaidBlock code={content} />', 'GenUIBlock raw={content} />']) {
    assert.ok(src.includes(marker), `自定义渲染 ${marker.split(' ')[0]} 必须仍在 SafeBlock 内`)
  }
  // 降级路径必须是纯文本 pre
  assert.ok(src.includes('PlainFallback'), '必须有统一纯文本降级组件')
})

test('结构：ChatArea 滚动必须走 useAutoScroll hook，禁止内联简易滚动逻辑回归', () => {
  const chat = read('components', 'ChatArea.tsx')
  assert.ok(chat.includes('useAutoScroll({'), 'ChatArea 必须使用 useAutoScroll')
  assert.ok(!chat.includes('nearBottomRef'), '旧的 nearBottomRef 简易滚动逻辑不得回归')
  assert.ok(!chat.includes('onScroll={onScroll}'), '滚动监听归 useAutoScroll，ChatArea 不得自带 onScroll')

  const hook = read('hooks', 'useAutoScroll.ts')
  // 三阈值三守卫的关键常量必须在位
  assert.ok(hook.includes('FOLLOW_BOTTOM_THRESHOLD_PX = 12'), '贴底阈值 12px（HiDPI 防亚像素）')
  assert.ok(hook.includes('PROGRAMMATIC_GUARD_MS = 150'), '程序滚动守卫 150ms')
  assert.ok(hook.includes('LAYOUT_GUARD_MS = 600'), 'pointerdown 封锁守卫 600ms')
  assert.ok(hook.includes('ResizeObserver'), '内容尺寸跟随必须用 ResizeObserver')
})

test('结构：SendBox 必须 key={currentSessionId} remount（切会话清空输入态）', () => {
  const chat = read('components', 'ChatArea.tsx')
  assert.match(chat, /<SendBox key=\{currentSessionId \?\? 'none'\}/, 'SendBox 切会话必须 remount 清空输入态')
})

test('结构：样式缓动必须收敛到 token（styles.css 除 :root 定义外无裸 cubic-bezier）', () => {
  const css = read('styles.css')
  for (const line of css.split('\n')) {
    if (/cubic-bezier/.test(line)) {
      assert.match(line.trim(), /^--pi-(ease|ease-sheet):/, `裸缓动曲线必须收敛到 token：${line.trim().slice(0, 60)}`)
    }
  }
})

test('结构：React 聊天使用持久化 Run，关闭 SSE 不得等同停止任务', () => {
  const chat = read('components', 'ChatArea.tsx')
  const api = read('api.ts')
  assert.ok(chat.includes('RunsApi.create('), '发送消息必须先创建持久化 Run')
  assert.ok(chat.includes('RunsApi.stream('), '消息流必须订阅 Run 事件账本')
  assert.ok(chat.includes('RunsApi.stop('), '手动停止必须调用显式 stop API')
  assert.ok(!chat.includes('ChatApi.send('), 'React 聊天不得退回请求即任务的旧 ChatApi')
  assert.ok(!chat.includes('abortRef'), '关闭浏览器订阅不得再通过 abortRef 停止任务')
  assert.ok(api.includes("'Last-Event-ID': String(cursor)"), '断线重连必须携带最后事件游标')
})

test('结构：心情胶囊是服务端情绪镜像，禁止本地点击换脸', () => {
  const chat = read('components', 'ChatArea.tsx')
  const hook = read('lib', 'useXiaoyuEmotion.ts')
  assert.ok(!chat.includes('setMood'), '不得保留本地 setMood 点击轮换逻辑')
  assert.ok(chat.includes('useXiaoyuEmotion') && hook.includes('emoMeta('), '必须使用服务端 VAD→表情映射（emoMeta）')
  assert.ok(chat.includes("case 'emotion':"), 'SSE emotion 事件必须被消费')
  const pill = chat.match(/<div[^>]*emo-pill[\s\S]*?>/)
  assert.ok(pill, 'emo-pill 元素必须存在')
  assert.ok(!pill[0].includes('onClick'), 'emo-pill 元素不得绑定 onClick 换脸')
})

test('长任务无事件只提示，不得由前端自动停止后台 Run', () => {
  const chat = read('components', 'ChatArea.tsx')
  assert.ok(chat.includes('const IDLE_WARN_MS = 600_000'), '10 分钟无事件后展示非阻塞提示')
  const start = chat.indexOf('  const streaming = !!stream')
  const end = chat.indexOf('  }, [streaming])', start)
  assert.ok(start >= 0 && end > start, '必须保留流式空闲提示计时器')
  const watchdog = chat.slice(start, end)
  assert.ok(watchdog.includes('setIdleSeconds(idle)'), '空闲时长只用于显示')
  assert.ok(!watchdog.includes('RunsApi.stop('), '空闲看门狗不得调用真正的停止 API')
  assert.ok(!watchdog.includes('updStream('), '空闲看门狗不得伪造错误或取消工具')
  assert.ok(!chat.includes('长时间无响应，正在停止'), '不得再用前台无消息推断任务失败')
  assert.ok(chat.includes('不会因息屏或断连自动停止'), '应向用户说明后台执行不依赖前台连接')
  const stop = chat.slice(chat.indexOf('  const stop = async () => {'), chat.indexOf('  const resumeRun ='))
  assert.ok(stop.includes('await RunsApi.stop(active.runId)'), '显式停止按钮仍需调用停止 API')
  assert.equal(chat.split('RunsApi.stop(').length - 1, 1, '只有用户手动停止路径能调用停止 API')
})

test('流式期间过滤本地 assistant 草稿，避免与实时流重复渲染 bash 工具卡', () => {
  const chat = read('components', 'ChatArea.tsx')
  assert.match(chat, /const renderMessages = stream \? messages\.filter\(m => !m\.isDraft\) : messages/, '流式期间不能把 IndexedDB 草稿和实时 assistant 同时渲染')
})

test('结构：聊天必须接住 SSE video 媒体并渲染 <video>', () => {
  const chat = read('components', 'ChatArea.tsx')
  const msg = read('components', 'Message.tsx')
  const types = read('types.ts')
  assert.ok(chat.includes("d.type === 'video'"), 'SSE media 必须收 video')
  assert.ok(chat.includes('videos:'), '流式态必须有 videos')
  assert.ok(msg.includes('<video'), '消息区必须能播视频')
  assert.ok(types.includes('videos?:'), 'ChatMessage 必须有 videos')
})

test('结构：会话视频必须提供移动端可点击下载，并在播放失败时保留下载入口', () => {
  const msg = read('components', 'Message.tsx')
  assert.ok(msg.includes('downloadApiFile'), '视频下载必须走带鉴权的下载 API')
  assert.ok(msg.includes('下载视频'), '视频播放器下方必须有明确下载按钮')
  assert.ok(msg.includes('onError'), '移动端播放失败时必须显示可下载状态')
})

test('结构：前端构建必须保留上一版指纹资源，避免懒加载模块在移动端更新后 404', () => {
  const vite = readFileSync(join(ROOT, 'frontend', 'vite.config.ts'), 'utf8')
  assert.match(vite, /emptyOutDir:\s*false/, 'Vite 构建不能清空旧指纹资源')
})

test('前端收到会话已更新事件后立即刷新会话列表', () => {
  const chat = read('components', 'ChatArea.tsx')
  assert.match(chat, /case 'session_updated':[\s\S]*?refreshSessions\(\)/, 'session_updated 必须立即刷新会话列表')
  assert.doesNotMatch(chat.match(/case 'session_updated':[\s\S]*?case 'completed':/)?.[0] || '', /mutateMsgs\(\)/, '流式收尾前不能刷新消息正文，避免和实时 assistant 重复')
})

test('跨端切回前台后必须刷新当前会话正文，并恢复 SWR 焦点/重连同步', () => {
  const chat = read('components', 'ChatArea.tsx')
  const store = read('store.tsx')
  assert.match(chat, /visibilitychange[\s\S]*?mutateMsgs\(\)/, '切回前台必须刷新当前会话消息')
  assert.match(chat, /revalidateOnFocus:\s*true/, '当前会话消息需允许焦点重验证')
  assert.match(chat, /revalidateOnReconnect:\s*true/, '当前会话消息需允许断线重连重验证')
  assert.match(store, /revalidateOnFocus:\s*true/, '会话目录需允许焦点重验证')
  assert.match(store, /revalidateOnReconnect:\s*true/, '会话目录需允许断线重连重验证')
})

test('会话库必须提供显式时间/编号排序入口', () => {
  const page = read('pages', 'SessionDb.tsx')
  assert.ok(page.includes('sortMode'), '会话库需要保存排序模式')
  assert.ok(page.includes('最近更新'), '会话库需要提供最近更新排序')
  assert.ok(page.includes('最早更新'), '会话库需要提供最早更新排序')
  assert.ok(page.includes('编号'), '会话库需要提供编号排序')
})


test('后端提交聊天记录后同时广播会话更新事件，支持其他前端实例同步', () => {
  const server = readFileSync(join(ROOT, 'server.mjs'), 'utf8')
  assert.match(server, /onSessionUpdated:\s*\(\{\s*run\s*\}\)\s*=>\s*busPush\(run\.sessionId,\s*"session_updated"/, '聊天记录提交后必须广播 session_updated 给会话订阅者')
})
