// MoodOrb 情绪灵珠测试（2026-09-03）
// 设计语言借鉴 murmur-web：状态即运动 / 一个身体多个内在 / 0.6s 缓动 / 积分相位。
// vadVisual 是纯函数（frontend/src/lib/emotion.ts），Node 25 原生 strip types 直接跑。
// MoodOrb.tsx 含 JSX，Node 不解析，用源码契约断言（同 frontend-ui-structure 先例）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vadVisual } from '../../frontend/src/lib/emotion.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p) => readFileSync(join(ROOT, 'frontend', 'src', ...p), 'utf8')

const S = (over) => ({ valence: 0.2, arousal: 0.3, dominance: 0.55, intensity: 0.3, ...over })

test('vadVisual：缺字段/空快照不抛错，回落默认专注参数', () => {
  for (const bad of [null, undefined, {}, { valence: 3, arousal: -9 }]) {
    const v = vadVisual(bad)
    assert.ok(v && typeof v.hue === 'number' && isFinite(v.hue), 'hue 必须是有限数')
    assert.ok(v.tempo >= 0.2 && v.tempo <= 1.2, 'tempo 落在设计区间')
    assert.ok(v.glow >= 0 && v.glow <= 1, 'glow 归一')
    assert.ok(v.depth >= 0 && v.depth <= 1, 'depth 归一')
    assert.ok(v.drift >= 0 && v.drift <= 1, 'drift 归一')
  }
})

test('vadVisual：valence 升高 → 色相变暖（hue 单调下降趋向暖金），下降 → 变冷', () => {
  const cold = vadVisual(S({ valence: -0.6 }))
  const base = vadVisual(S({ valence: 0.2 }))
  const warm = vadVisual(S({ valence: 0.7 }))
  assert.ok(warm.hue < base.hue && base.hue < cold.hue, `暖色 hue 应更小（金 38）冷色更大（青 200）：${warm.hue} < ${base.hue} < ${cold.hue}`)
})

test('vadVisual：低落（低 valence 低 arousal）→ 明度更低、暗核更深，兴奋 → 明度更高', () => {
  const low = vadVisual(S({ valence: -0.5, arousal: -0.3 }))
  const base = vadVisual(S({}))
  const high = vadVisual(S({ valence: 0.7, arousal: 0.6, intensity: 0.7 }))
  assert.ok(low.light < base.light && base.light < high.light, `明度单调：${low.light} < ${base.light} < ${high.light}`)
  assert.ok(low.depth > base.depth, '低落暗核应更深')
})

test('vadVisual：arousal 升高 → 呼吸节奏加快、内在漂移变大（小幅波动也可见）', () => {
  const calm = vadVisual(S({ arousal: 0.3 }))
  const excited = vadVisual(S({ arousal: 0.8 }))
  assert.ok(excited.tempo > calm.tempo, 'arousal↑ tempo↑')
  assert.ok(excited.drift > calm.drift, 'arousal↑ drift↑')
  // 情绪连续可见的关键：相邻 VAD 差异必须产生参数差异（8 桶 emoji 时代 +0.05 完全不可见）
  const a = vadVisual(S({ valence: 0.2 }))
  const b = vadVisual(S({ valence: 0.28 }))
  assert.ok(a.hue !== b.hue || a.light !== b.light, '±0.08 的 valence 变化必须产生可见参数差')
})

test('MoodOrb 组件契约：积分相位、缓动、reduced-motion 静态、隐藏页签暂停、DPR 上限 2', () => {
  const src = read('components', 'MoodOrb.tsx')
  assert.match(src, /phase \+= dt \* Math\.PI \* 2 \* cur\.tempo/, '必须用积分相位驱动呼吸（tempo 变化不跳帧）')
  assert.match(src, /1 - Math\.exp\(-EASE_K \* dt\)/, '参数必须指数缓动追赶目标（murmur 0.6s 过渡同量级）')
  assert.match(src, /prefers-reduced-motion/, 'reduced-motion 必须静态化')
  assert.match(src, /visibilitychange/, '隐藏页签必须暂停动画')
  assert.match(src, /Math\.min\(.*devicePixelRatio.*,\s*2\)/, 'DPR 必须设上限')
  assert.match(src, /cancelAnimationFrame/, '卸载必须取消 rAF')
  assert.match(src, /const TICKS = 24/, '保留 24 段 HUD 刻度')
  assert.match(src, /const SCAN_PERIOD = 5\.0/, '保留扫描周期')
  assert.match(src, /scanPhase = \(scanPhase \+ dt\) % SCAN_PERIOD/, '扫描使用积分相位')
  assert.match(src, /jumpFrames = 3/, '保留情绪急动反馈')
  assert.match(src, /vadVisual\(state\)/, '保留 VAD 数据流')
  assert.ok((src.match(/ctx\.createRadialGradient/g) || []).length >= 5, '保留原材质层')
})

test('ChatArea：心情 pill 渲染 MoodOrb，emoji 不再出现在 pill 内', () => {
  const chat = read('components', 'ChatArea.tsx')
  assert.match(chat, /<MoodOrb\b/, 'pill 应渲染 MoodOrb 灵珠')
  assert.match(chat, /import\s*\{[^}]*MoodOrb[^}]*\}\s*from\s*'\.\/MoodOrb'/, '应从同目录导入 MoodOrb')
  const pill = chat.match(/emo-pill[\s\S]{0,600}?\n        <\/div>/)
  assert.ok(pill, '应能定位 emo-pill 渲染块')
  assert.ok(!pill[0].includes('emo.meta.emoji'), 'pill 内不得再渲染 emoji')
  assert.match(pill[0], /w-\[30px\] h-\[30px\]/, '2026-09-03 三调：30px 容器（40 手机端偏大）')
  assert.ok(!pill[0].includes('border-pi-border-soft'), '裸球模式去外框')
  assert.match(pill[0], /size=\{24\}/, '灵珠 24px')
  assert.match(chat, /emoTooltip\(/, 'tooltip 文案（情绪+性格）必须保留')
})

test('对话右上角灵珠和工作台潮汐必须共用同一份情绪快照', () => {
  const hook = read('lib', 'useXiaoyuEmotion.ts')
  const chat = read('components', 'ChatArea.tsx')
  const board = read('pages', 'Board.tsx')
  assert.match(hook, /export const EMO_LIVE_KEY/, '必须有共享缓存键')
  assert.ok(hook.includes('EmotionApi.display()'), '非消费式共享快照不带 session')
  assert.ok(chat.includes('const companionEmotion = companion.emotion'), '对话顶栏复用公仔控制器的共享情绪')
  assert.ok(read('components', 'xiaoyu', 'useCompanion.ts').includes('useXiaoyuEmotion()'), '控制器走共享钩子')
  assert.ok(board.includes('useXiaoyuEmotion'), '工作台走同一钩子')
  assert.ok(!/EmotionApi\.get\(\s*currentSessionId\s*\)/.test(chat), '对话不得再按会话另拉一份')
  assert.ok(chat.includes('publishEmotion'), 'SSE emotion 必须写回共享缓存，工作台才能跟上')
})

test('GradientField：欢迎页氛围层——懒加载拆块、深色限定、WebGL 预检、纯装饰', () => {
  const src = read('components', 'GradientField.tsx')
  assert.match(src, /lazy\(\(\) => import\('\.\/ShaderGradientInner'\)\)/, 'three 必须经 React.lazy 拆块，不进主包')
  assert.match(src, /prefers-reduced-motion/, 'reduced-motion 必须静态回退')
  assert.match(src, /isDarkTheme/, '浅色主题不得渲染深色渐变')
  assert.match(src, /getContext\('webgl2'\)/, '必须预检 WebGL，失败静默回退')
  assert.match(src, /pointer-events-none/, '纯装饰不拦交互')
  const inner = read('components', 'ShaderGradientInner.tsx')
  assert.match(inner, /@shadergradient\/react/, '实现块引入 shader gradient')
  assert.match(inner, /pixelDensity=\{1\}/, '像素密度限 1 换性能')
  const chat = read('components', 'ChatArea.tsx')
  assert.ok(!chat.includes('<GradientField'), '日常工作入口不再挂载装饰性渐变场')
  assert.ok(chat.includes('chat-workstart'), '欢迎页使用工作入口布局')
})
