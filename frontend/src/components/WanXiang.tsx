import { useState, useCallback } from 'react'
import { Sparkles, Copy, Check } from 'lucide-react'
import { composeImagePrompt, composeImageShot, IMAGE_SCENES, IMAGE_GRAMMARS, IMAGE_EXAMPLES } from '../lib/image-prompt.mjs'
import PromptSmartFill from './PromptSmartFill'

// ── 万像人物 · 写真提示词生成器（React化）──
// 纯前端：构图骨架 / 示例成稿 → 五要素 → 光影风格 → 输出提示词

type SceneKey = keyof typeof IMAGE_SCENES & string
const GRAMMAR_KEYS = Object.keys(IMAGE_GRAMMARS) as Array<keyof typeof IMAGE_GRAMMARS & string>
const EXAMPLE_KEYS = Object.keys(IMAGE_EXAMPLES) as Array<keyof typeof IMAGE_EXAMPLES & string>
const LIGHTS = ['窗边柔光', '三点式布光', '电影级冷暖光对冲', '逆光剪影', '戏剧聚光', '梦幻柔焦', '金色辉光'] as const
const STYLES = ['自然光写实主义', 'editorial_fashion', '工笔画', '水墨漫画融合', '胶片质感', '电影海报', '概念艺术'] as const
const MOODS = ['唯美朦胧', '清冷淡雅', '温暖柔和', '高对比戏剧', '复古胶片', '赛博霓虹', '水墨意境'] as const
const SHOTS = ['半身特写', '全身', '特写', '七分身', '胸部以上'] as const
const ANGLES = ['平视', '仰视', '俯视', '微仰视'] as const

function pickListed<T extends string>(v: string | undefined, list: readonly T[], fallback: T): T {
  return (list as readonly string[]).includes(v || '') ? (v as T) : fallback
}

const PICK = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

// ─── 负面词库 ───
const NEG_UNIVERSAL = '没有多余肢体，没有六根手指，没有畸形，没有模糊，没有水印，没有文字，没有丑陋'
const NEG_REAL = '不是卡通，不是动画，不是3D渲染，不是塑料感，不是游戏画面'
const NEG_BG = '没有杂乱背景，没有其他人，没有无关物体'
const NEG_TO_CN: Record<string, string> = {
  '没有多余肢体': '肢体完整', '没有六根手指': '五指自然', '没有畸形': '形态正常',
  '没有模糊': '画面清晰', '没有水印': '无水印', '没有文字': '无文字', '没有丑陋': '五官端正',
  '不是卡通': '真人写实', '不是动画': '非动画', '不是3D渲染': '照片质感',
  '不是塑料感': '真实皮肤纹理', '不是游戏画面': '非游戏风格',
  '没有杂乱背景': '纯净背景', '没有其他人': '单人画面', '没有无关物体': '主体聚焦',
}

const GAMBLE = {
  gender: ['女性', '男性'], scene: GRAMMAR_KEYS,
  style: ['自然光写实主义', 'editorial_fashion', '工笔画', '水墨漫画融合', '胶片质感', '电影海报', '概念艺术'],
  body: ['沙漏形', '梨形', '矩形', '倒三角', '纤细型', '匀称型'],
  lighting: ['窗边柔光', '三点式布光', '电影级冷暖光对冲', '逆光剪影', '戏剧聚光', '梦幻柔焦', '金色辉光'],
}
const PICKGAMBLE = <T extends keyof typeof GAMBLE>(dim: T, locks: Set<string>, chance: number) => {
  if (locks.has(dim)) return null
  if (Math.random() >= chance) return null
  return PICK(GAMBLE[dim])
}

// ─── Tag / Toggle 组件 ───
const Tags = ({ items, value, onChange }: { items: [string, string][]; value: string; onChange: (v: string) => void }) => (
  <div className="flex flex-wrap gap-1.5">
    {items.map(([k, label]) => (
      <button key={k} onClick={() => onChange(k)}
        className={`px-2.5 py-1 rounded-full text-[11px] border transition-colors duration-fast ${value === k ? 'bg-pi-accent text-pi-on-accent border-pi-accent font-medium' : 'bg-transparent text-pi-dim border-pi-border-soft hover:text-pi-text hover:border-pi-dim'}`}>
        {label}
      </button>
    ))}
  </div>
)

const Toggle = ({ v, set, label }: { v: boolean; set: (v: boolean) => void; label: string }) => (
  <label className="flex items-center gap-2.5 cursor-pointer">
    <span className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${v ? 'bg-pi-accent' : 'bg-pi-border-soft'}`} onClick={() => set(!v)}>
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${v ? 'translate-x-4' : ''}`} />
    </span>
    <span className={`text-[12px] transition-colors ${v ? 'text-pi-text font-medium' : 'text-pi-dim'}`}>{label}</span>
  </label>
)

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div><label className="block text-[11px] text-pi-dim2 mb-1 tracking-wide">{label}</label>{children}</div>
)

// ─── 主组件 ───
export default function WanXiang({ onUsePrompt }: { onUsePrompt?: (prompt: string) => void } = {}) {
  // 场景
  const [scene, setScene] = useState<SceneKey>('free')
  // 五要素
  const [gender, setGender] = useState('女性')
  const [age, setAge] = useState(28)
  const [ptype, setPtype] = useState('真人')
  const [look, setLook] = useState('')
  const [height, setHeight] = useState(168)
  const [weight, setWeight] = useState(52)
  const [body, setBody] = useState('沙漏形')
  const [face, setFace] = useState('鹅蛋脸')
  const [skintone, setSkintone] = useState('瓷白')
  const [outfit, setOutfit] = useState('')
  const [shot, setShot] = useState('半身特写')
  const [angle, setAngle] = useState('平视')
  const [pose, setPose] = useState('')
  const [expression, setExpression] = useState('')
  // 光影·风格
  const [lighting, setLighting] = useState('窗边柔光')
  const [mood, setMood] = useState('唯美朦胧')
  const [style, setStyle] = useState('自然光写实主义')
  const [bg, setBg] = useState('')
  // 技术增强
  const [uhq, setUhq] = useState(true)
  const [zero, setZero] = useState(true)
  const [deai, setDeai] = useState(false)
  const [composition, setComposition] = useState(false)
  const [emotion, setEmotion] = useState(false)
  // 平台
  const [platform, setPlatform] = useState('dreamina')
  // 负面过滤
  const [negUniversal, setNegUniversal] = useState(true)
  const [negReal, setNegReal] = useState(true)
  const [negBg, setNegBg] = useState(false)
  // 赌图
  const [gamble, setGamble] = useState(false)
  const [gambleChance, setGambleChance] = useState(0.5)
  const [gambleLocks, setGambleLocks] = useState<Set<string>>(new Set(['gender']))
  // 输出
  const [idea, setIdea] = useState('')
  const [output, setOutput] = useState('')
  const [visualPrompt, setVisualPrompt] = useState('')
  const [copied, setCopied] = useState('')

  const pickGrammar = useCallback((k: SceneKey) => {
    const s = IMAGE_GRAMMARS[k as keyof typeof IMAGE_GRAMMARS]
    if (!s) return
    setScene(k)
    const shot = composeImageShot(s, { look, outfit, bg })
    if (shot.shot) setShot(pickListed(shot.shot, SHOTS, '半身特写'))
    if (shot.angle) setAngle(pickListed(shot.angle, ANGLES, '平视'))
    if (shot.pose) setPose(shot.pose)
    if (shot.mood) setMood(shot.mood)
    setLighting(shot.lighting)
    setStyle(shot.style)
    if (!bg && shot.bg) setBg(shot.bg)
  }, [look, outfit, bg])
  const pickExample = useCallback((k: SceneKey) => {
    const s = IMAGE_EXAMPLES[k as keyof typeof IMAGE_EXAMPLES]
    if (!s) return
    setScene(k)
    setLook(s.look)
    setOutfit(s.outfit)
    setPose(s.pose)
    setBg(s.bg)
    setStyle(s.style)
    setLighting(s.lighting)
  }, [])

  // 生成提示词
  const generate = useCallback(() => {
    // 赌图：按概率随机覆写风格/身形/光影（旧版万像核心玩法）；性别默认锁定可解锁
    let g = gender
    let _style = style, _body = body, _lighting = lighting
    const gambled: string[] = []
    if (gamble) {
      const roll = <T,>(dim: keyof typeof GAMBLE, pool: readonly T[]): T | null =>
        (gambleLocks.has(dim) ? null : (Math.random() < gambleChance ? PICK([...pool]) : null))
      if (!gambleLocks.has('gender')) { const v = roll('gender', GAMBLE.gender); if (v) g = v as string }
      const st = roll('style', GAMBLE.style); if (st) { _style = st; gambled.push('风格') }
      const bd = roll('body', GAMBLE.body); if (bd) { _body = bd; gambled.push('身形') }
      const lt = roll('lighting', GAMBLE.lighting); if (lt) { _lighting = lt; gambled.push('光影') }
    }
    const sk = skintone
    const _look = look || '面容端正，五官协调'
    const _outfit = outfit || '简约得体的服装'
    const _pose = pose || '自然站姿，重心稳定'
    const _expr = expression || '自然微笑，眼神有神'
    const _bg = bg || '纯色背景'
    let light = _lighting
    if (zero) light += '（零器材模式：自然天幕光，无电线，无灯架，无器材入镜）'
    const tech: string[] = []
    if (uhq) tech.push('超清画质高细节，极致细节，干净光滑的画面')
    if (deai) tech.push('真实皮肤纹理，毛孔清晰可见，照片级真实感')
    if (composition) tech.push('黄金分割构图，引导线引导视线，画面平衡有张力')
    if (emotion) tech.push('情绪光晕，光晕自然扩散，氛围感强')
    const visual = composeImagePrompt({
      ptype, gender: g, age, face, look: _look, skintone: sk,
      height, weight, body: _body, expression: _expr, outfit: _outfit,
      shot, angle, pose: _pose, lighting: light, mood, style: _style, bg: _bg, tech,
    })
    setVisualPrompt(visual)
    onUsePrompt?.(visual)

    if (platform === 'dreamina') {
      const negArr: string[] = []
      if (negUniversal) negArr.push(NEG_UNIVERSAL)
      if (negReal) negArr.push(NEG_REAL)
      if (negBg) negArr.push(NEG_BG)
      const negJoined = negArr.join('，')
      const wParts = ['五官端正:0.85', '肢体自然:0.85', '真实皮肤纹理:0.85']
      if (uhq) wParts.unshift('超清画质:0.9')
      const negPairs = negJoined.split('，').filter(Boolean).map(x => `${NEG_TO_CN[x] || x}:0.85`).join(', ')
      setOutput((gambled.length ? `【赌图命中】${gambled.join(' / ')}\n\n` : '') + `【画面描述】\n${visual}\n\n【权重调整】\n${wParts.join(', ')}${negPairs ? '\n' + negPairs : ''}\n\n【质量保障】\n${negJoined}`)
    } else if (platform === 'mj') {
      const negArr: string[] = []
      if (negUniversal) negArr.push(...NEG_UNIVERSAL.split('，'))
      if (negReal) negArr.push(...NEG_REAL.split('，'))
      if (negBg) negArr.push(...NEG_BG.split('，'))
      setOutput(visual + '\n\n--style raw --stylize 600 --ar 2:3' + (negArr.length ? ' --no ' + negArr.join(', ') : ''))
    } else {
      const negArr: string[] = [...NEG_UNIVERSAL.split('，')]
      if (negReal) negArr.push(...NEG_REAL.split('，'))
      if (negBg) negArr.push(...NEG_BG.split('，'))
      setOutput(visual + '\n\nNegative prompt: ' + negArr.filter(Boolean).join(', ') + '\n\nControlNet: openpose + depth | LoRA: <lora:body_proportion_v2:0.7>')
    }
  }, [gender, age, ptype, look, height, weight, body, face, skintone, outfit, shot, angle, pose, expression, lighting, mood, style, bg, uhq, zero, deai, composition, emotion, platform, negUniversal, negReal, negBg, gamble, gambleChance, gambleLocks, onUsePrompt])

  const copyToClipboard = useCallback(async () => {
    if (!output) return
    try { await navigator.clipboard.writeText(output); setCopied('1'); setTimeout(() => setCopied(''), 1500) } catch {}
  }, [output])

  return (
    <div className="space-y-4">
      <div className="panel !p-3 space-y-3">
        <div>
          <h3 className="text-[13px] font-semibold text-pi-text mb-1 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-pi-accent/15 text-pi-accent text-[10px] font-bold flex items-center justify-center">1</span>
            构图骨架
          </h3>
          <p className="text-[11px] text-pi-dim2 mb-2">只改怎么拍和光影，不改你写的脸和衣服。</p>
          <div className="flex flex-wrap gap-1.5">
            {GRAMMAR_KEYS.map(k => (
              <button key={k} type="button" onClick={() => pickGrammar(k)}
                className={`px-2.5 min-h-11 rounded-full text-[11px] border transition-colors duration-fast ${scene === k ? 'bg-pi-accent text-pi-on-accent border-pi-accent font-medium' : 'bg-transparent text-pi-dim border-pi-border-soft hover:text-pi-text hover:border-pi-dim'}`}>
                {IMAGE_GRAMMARS[k].icon} {IMAGE_GRAMMARS[k].name}
              </button>
            ))}
          </div>
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-pi-text mb-1">示例成稿</h3>
          <p className="text-[11px] text-pi-dim2 mb-2">参考片，点了会换外貌和服装。</p>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLE_KEYS.map(k => (
              <button key={k} type="button" onClick={() => pickExample(k)}
                className={`px-2.5 min-h-11 rounded-full text-[11px] border transition-colors duration-fast ${scene === k ? 'bg-pi-accent text-pi-on-accent border-pi-accent font-medium' : 'bg-transparent text-pi-dim border-pi-border-soft hover:text-pi-text hover:border-pi-dim'}`}>
                {IMAGE_EXAMPLES[k].icon} {IMAGE_EXAMPLES[k].name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 五要素 */}
      <div className="panel !p-3 space-y-3">
        <h3 className="text-[13px] font-semibold text-pi-text mb-2.5 flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-pi-accent/15 text-pi-accent text-[10px] font-bold flex items-center justify-center">2</span>
          基本信息
        </h3>
        <div className="grid grid-cols-3 gap-2">
          <Field label="性别">
            <select className="input-pi !py-1.5 text-[12px]" value={gender} onChange={e => setGender(e.target.value)}><option>女性</option><option>男性</option></select>
          </Field>
          <Field label="年龄">
            <input type="number" min={16} max={80} className="input-pi !py-1.5 text-[12px]" value={age} onChange={e => setAge(+e.target.value)} />
          </Field>
          <Field label="类型">
            <select className="input-pi !py-1.5 text-[12px]" value={ptype} onChange={e => setPtype(e.target.value)}><option>真人</option><option>古风</option><option>漫画</option></select>
          </Field>
        </div>
        <Field label="外貌特征">
          <input className="input-pi text-[12px]" placeholder="皮肤/脸型/五官。空着就一句话填。" value={look} onChange={e => setLook(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="身高 cm"><input type="number" className="input-pi !py-1.5 text-[12px]" value={height} onChange={e => setHeight(+e.target.value)} /></Field>
          <Field label="体重 kg"><input type="number" className="input-pi !py-1.5 text-[12px]" value={weight} onChange={e => setWeight(+e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="身材"><select className="input-pi !py-1.5 text-[12px]" value={body} onChange={e => setBody(e.target.value)}><option>沙漏形</option><option>梨形</option><option>矩形</option><option>倒三角</option><option>纤细型</option><option>匀称型</option></select></Field>
          <Field label="脸型"><select className="input-pi !py-1.5 text-[12px]" value={face} onChange={e => setFace(e.target.value)}><option>鹅蛋脸</option><option>瓜子脸</option><option>圆脸</option><option>方脸</option><option>心形脸</option><option>长脸</option></select></Field>
          <Field label="肤色"><select className="input-pi !py-1.5 text-[12px]" value={skintone} onChange={e => setSkintone(e.target.value)}><option>瓷白</option><option>暖白</option><option>蜜色</option><option>小麦色</option></select></Field>
        </div>
        <Field label="服装">
          <input className="input-pi text-[12px]" placeholder="服装描述。空着就一句话填。" value={outfit} onChange={e => setOutfit(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="景别"><select className="input-pi !py-1.5 text-[12px]" value={shot} onChange={e => setShot(e.target.value)}><option>半身特写</option><option>全身</option><option>特写</option><option>七分身</option><option>胸部以上</option></select></Field>
          <Field label="视角"><select className="input-pi !py-1.5 text-[12px]" value={angle} onChange={e => setAngle(e.target.value)}><option>平视</option><option>仰视</option><option>俯视</option><option>微仰视</option></select></Field>
        </div>
        <Field label="肢体动作"><input className="input-pi text-[12px]" placeholder="肢体动作描述" value={pose} onChange={e => setPose(e.target.value)} /></Field>
        <Field label="表情"><input className="input-pi text-[12px]" placeholder="表情描述" value={expression} onChange={e => setExpression(e.target.value)} /></Field>
      </div>

      {/* 光影·风格 */}
      <div className="panel !p-3 space-y-3">
        <h3 className="text-[13px] font-semibold text-pi-text mb-2.5 flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-pi-accent/15 text-pi-accent text-[10px] font-bold flex items-center justify-center">3</span>
          光影 · 氛围 · 风格
        </h3>
        <Field label="光影">
          <input className="input-pi text-[12px] min-h-11" value={lighting} onChange={e => setLighting(e.target.value)} />
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {LIGHTS.map((l) => (
              <button key={l} type="button" onClick={() => setLighting(l)}
                className={`px-2 py-1 rounded-full text-[11px] border ${lighting === l ? 'bg-pi-accent text-pi-on-accent border-pi-accent' : 'bg-transparent text-pi-dim border-pi-border-soft'}`}>{l}</button>
            ))}
          </div>
        </Field>
        <Field label="氛围">
          <input className="input-pi text-[12px] min-h-11" value={mood} onChange={e => setMood(e.target.value)} />
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {MOODS.map((m) => (
              <button key={m} type="button" onClick={() => setMood(m)}
                className={`px-2 py-1 rounded-full text-[11px] border ${mood === m ? 'bg-pi-accent text-pi-on-accent border-pi-accent' : 'bg-transparent text-pi-dim border-pi-border-soft'}`}>{m}</button>
            ))}
          </div>
        </Field>
        <Field label="风格">
          <input className="input-pi text-[12px] min-h-11" value={style} onChange={e => setStyle(e.target.value)} />
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {STYLES.map((st) => (
              <button key={st} type="button" onClick={() => setStyle(st)}
                className={`px-2 py-1 rounded-full text-[11px] border ${style === st ? 'bg-pi-accent text-pi-on-accent border-pi-accent' : 'bg-transparent text-pi-dim border-pi-border-soft'}`}>{st}</button>
            ))}
          </div>
        </Field>
        <Field label="背景"><input className="input-pi text-[12px]" placeholder="背景环境描述" value={bg} onChange={e => setBg(e.target.value)} /></Field>
      </div>

      {/* 技术增强 + 输出 */}
      <div className="panel !p-3 space-y-2.5">
        <h3 className="text-[13px] font-semibold text-pi-text mb-2.5">技术增强 & 输出</h3>
        <Toggle v={uhq} set={setUhq} label="超高清画质（UHQ）" />
        <Toggle v={zero} set={setZero} label="零器材模式" />
        <Toggle v={deai} set={setDeai} label="去AI化真实感" />
        <Toggle v={composition} set={setComposition} label="构图系统" />
        <Toggle v={emotion} set={setEmotion} label="情绪光晕" />
        <hr className="border-pi-border-soft my-2" />
        <Field label="输出平台">
          <div className="flex gap-1.5">
            {[['dreamina', '即梦'], ['mj', 'MJ'], ['sd', 'SD']].map(([k, l]) => (
              <button key={k} onClick={() => setPlatform(k)} className={`px-2.5 py-1 rounded-full text-[11px] border transition-colors duration-fast ${platform === k ? 'bg-pi-accent text-pi-on-accent border-pi-accent' : 'bg-transparent text-pi-dim border-pi-border-soft hover:text-pi-text'}`}>{l}</button>
            ))}
          </div>
        </Field>
        <div className="flex items-center gap-3">
          <Toggle v={negUniversal} set={setNegUniversal} label="通用质量过滤" />
          <Toggle v={negReal} set={setNegReal} label="写实强化" />
          <Toggle v={negBg} set={setNegBg} label="纯净背景" />
        </div>
        <hr className="border-pi-border-soft my-2" />
        {/* 赌图模式 */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <Toggle v={gamble} set={setGamble} label="🎲 赌图模式" />
          {gamble && (
            <>
              <label className="text-[11px] text-pi-dim flex items-center gap-1.5">命中概率
                <input type="range" min={10} max={90} step={5} value={Math.round(gambleChance * 100)} onChange={e => setGambleChance(+e.target.value / 100)} className="w-24 accent-pi-accent" />
                <span className="text-pi-text font-mono w-8 text-right">{Math.round(gambleChance * 100)}%</span>
              </label>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-pi-dim2">锁定:</span>
                {(['gender', 'style', 'body', 'lighting'] as const).map(dim => (
                  <button key={dim} onClick={() => setGambleLocks(prev => {
                    const next = new Set(prev); next.has(dim) ? next.delete(dim) : next.add(dim); return next
                  })}
                    className={`px-1.5 py-0.5 rounded-full text-[10px] border ${gambleLocks.has(dim) ? 'bg-pi-accent/15 text-pi-accent border-pi-accent/40' : 'bg-transparent text-pi-dim2 border-pi-border-soft'}`}>
                    {{ gender: '性别', style: '风格', body: '身形', lighting: '光影' }[dim]}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 生成按钮 */}
      <div className="space-y-2">
        <Field label="一句话灵感">
          <input className="input-pi text-[12px] min-h-11" placeholder="谁、在哪、什么气质。空着就按当前格子生成。" value={idea} onChange={e => setIdea(e.target.value)} />
        </Field>
        <PromptSmartFill
          kind="image"
          idea={idea || [look, outfit, pose, bg, `${gender}${age}岁`].filter(Boolean).join('，')}
          draft={visualPrompt}
          onFilled={({ prompt, fields }) => {
            if (fields?.look) setLook(fields.look)
            if (fields?.outfit) setOutfit(fields.outfit)
            if (fields?.pose) setPose(fields.pose)
            if (fields?.expression) setExpression(fields.expression)
            if (fields?.bg) setBg(fields.bg)
            if (fields?.lighting) setLighting(fields.lighting)
            if (fields?.style) setStyle(fields.style)
            if (fields?.mood) setMood(fields.mood)
            setVisualPrompt(prompt)
            setOutput(prompt)
            onUsePrompt?.(prompt)
          }}
        />
      </div>
      <button onClick={generate} className="w-full py-3 rounded-pi-lg bg-gradient-to-r from-pi-accent to-pi-accent2 text-white font-semibold text-sm tracking-wider hover:brightness-110 transition-colors duration-fast">
        <Sparkles className="w-4 h-4 inline mr-2" />生成提示词
      </button>

      {/* 输出 */}
      {output && (
        <div className="panel !p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold text-pi-text">生成结果</span>
            <div className="flex items-center gap-1.5">
              {onUsePrompt && (
                <button onClick={() => onUsePrompt(visualPrompt || output)} className="btn-tool text-xs">填入出图框</button>
              )}
              <button onClick={copyToClipboard} className="btn-tool text-xs inline-flex items-center gap-1.5">
                {copied ? <><Check className="w-3.5 h-3.5 text-emerald-400" />已复制</> : <><Copy className="w-3.5 h-3.5" />复制</>}
              </button>
            </div>
          </div>
          <pre className="bg-black/30 rounded-pi-md p-3 text-[12px] text-pi-dim whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto font-mono">{output}</pre>
        </div>
      )}
    </div>
  )
}
