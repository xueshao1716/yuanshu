import { useMemo, useRef, useState } from 'react'
import { Sparkles, Copy, Check } from 'lucide-react'
import { VIDEO_GRAMMARS, VIDEO_EXAMPLES, VIDEO_SCENES, buildVideoPrompt, composeVideoScript } from '../lib/video-prompt.mjs'
import PromptSmartFill from './PromptSmartFill'

type SceneKey = keyof typeof VIDEO_SCENES & string
const GRAMMAR_KEYS = Object.keys(VIDEO_GRAMMARS) as Array<keyof typeof VIDEO_GRAMMARS & string>
const EXAMPLE_KEYS = Object.keys(VIDEO_EXAMPLES) as Array<keyof typeof VIDEO_EXAMPLES & string>
const FREE = VIDEO_GRAMMARS.free

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div><label className="block text-[11px] text-pi-dim2 mb-1 tracking-wide">{label}</label>{children}</div>
)

export default function VideoPrompt({ onUsePrompt, onSpecChange }: {
  onUsePrompt?: (prompt: string) => void
  onSpecChange?: (spec: { seconds: string; frame: string }) => void
}) {
  const [scene, setScene] = useState<SceneKey>('free')
  const [subject, setSubject] = useState('')
  const [action, setAction] = useState('')
  const [place, setPlace] = useState('')
  const [lighting, setLighting] = useState(FREE.lighting)
  const [camera, setCamera] = useState(FREE.camera)
  const [style, setStyle] = useState(FREE.style)
  const [constraint, setConstraint] = useState(FREE.constraint)
  const [seconds, setSeconds] = useState(FREE.seconds)
  const [frame, setFrame] = useState(FREE.frame)
  const [beats, setBeats] = useState('')
  const [memory, setMemory] = useState('')
  const [richness, setRichness] = useState<'lite' | 'standard'>('standard')
  const [idea, setIdea] = useState('')
  const [output, setOutput] = useState('')
  const [copied, setCopied] = useState('')
  const autoShot = useRef({ lighting: FREE.lighting, camera: FREE.camera, style: FREE.style, memory: '' })

  const writeShot = (shot: { lighting: string; camera: string; style: string; constraint: string; seconds: string; frame: string }) => {
    setLighting(shot.lighting)
    setCamera(shot.camera)
    setStyle(shot.style)
    setConstraint(shot.constraint)
    setSeconds(shot.seconds)
    setFrame(shot.frame)
    autoShot.current = { ...autoShot.current, lighting: shot.lighting, camera: shot.camera, style: shot.style }
    onSpecChange?.({ seconds: shot.seconds, frame: shot.frame })
  }
  const pickGrammar = (key: SceneKey) => {
    const g = VIDEO_GRAMMARS[key as keyof typeof VIDEO_GRAMMARS]
    if (!g) return
    setScene(key)
    setBeats('')
    const script = composeVideoScript(g, { subject, action, scene: place })
    writeShot(script)
    setMemory(script.memory)
    autoShot.current = { ...autoShot.current, memory: script.memory }
  }
  const pickExample = (key: SceneKey) => {
    const s = VIDEO_EXAMPLES[key as keyof typeof VIDEO_EXAMPLES]
    if (!s) return
    setScene(key)
    setSubject(s.subject)
    setAction(s.action)
    setPlace(s.scene)
    setMemory(s.memory || '')
    setBeats('')
    writeShot({
      lighting: s.lighting, camera: s.camera, style: s.style,
      constraint: s.constraint, seconds: s.seconds, frame: s.frame,
    })
  }
  const refreshShot = (next: { subject?: string; action?: string; scene?: string }) => {
    const g = VIDEO_GRAMMARS[scene as keyof typeof VIDEO_GRAMMARS]
    if (!g || lighting !== autoShot.current.lighting) return
    const script = composeVideoScript(g, {
      subject: next.subject ?? subject,
      action: next.action ?? action,
      scene: next.scene ?? place,
    })
    setLighting(script.lighting)
    setStyle(script.style)
    if (!memory || memory === autoShot.current.memory) setMemory(script.memory)
    autoShot.current = { ...autoShot.current, lighting: script.lighting, style: script.style, memory: script.memory }
  }

  const draft = useMemo(() => buildVideoPrompt({
    sceneKey: scene,
    subject, action, scene: place, lighting, camera, style, quality: '720P 清晰',
    constraint, seconds, frame, richness, beats, memory,
  }), [scene, subject, action, place, lighting, camera, style, constraint, seconds, frame, richness, beats, memory])

  const generate = () => {
    setOutput(draft)
    onUsePrompt?.(draft)
    onSpecChange?.({ seconds, frame })
  }

  const copyToClipboard = async () => {
    if (!output) return
    try { await navigator.clipboard.writeText(output); setCopied('1'); setTimeout(() => setCopied(''), 1500) } catch {}
  }

  return (
    <div className="space-y-4">
      <div className="panel !p-3 space-y-3">
        <div>
          <h3 className="text-[13px] font-semibold text-pi-text mb-1">运镜骨架</h3>
          <p className="text-[11px] text-pi-dim2 mb-2">只改怎么拍和画幅，不改你写的人。</p>
          <div className="flex flex-wrap gap-1.5">
            {GRAMMAR_KEYS.map((k) => (
              <button key={k} type="button" onClick={() => pickGrammar(k)}
                className={`px-2.5 min-h-11 rounded-full text-[11px] border transition-colors duration-fast ${scene === k ? 'bg-pi-accent text-pi-on-accent border-pi-accent font-medium' : 'bg-transparent text-pi-dim border-pi-border-soft hover:text-pi-text hover:border-pi-dim'}`}>
                {VIDEO_GRAMMARS[k].icon} {VIDEO_GRAMMARS[k].name}
              </button>
            ))}
          </div>
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-pi-text mb-1">示例成稿</h3>
          <p className="text-[11px] text-pi-dim2 mb-2">参考片，点了会换主体和场景。</p>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLE_KEYS.map((k) => (
              <button key={k} type="button" onClick={() => pickExample(k)}
                className={`px-2.5 min-h-11 rounded-full text-[11px] border transition-colors duration-fast ${scene === k ? 'bg-pi-accent text-pi-on-accent border-pi-accent font-medium' : 'bg-transparent text-pi-dim border-pi-border-soft hover:text-pi-text hover:border-pi-dim'}`}>
                {VIDEO_EXAMPLES[k].icon} {VIDEO_EXAMPLES[k].name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel !p-3 space-y-3">
        <h3 className="text-[13px] font-semibold text-pi-text">镜头卡 · 主体 / 动作 / 场景</h3>
        <Field label="主体"><input className="input-pi text-[12px] min-h-11" value={subject} onChange={e => { setSubject(e.target.value); refreshShot({ subject: e.target.value }) }} /></Field>
        <Field label="动作"><input className="input-pi text-[12px] min-h-11" value={action} onChange={e => { setAction(e.target.value); refreshShot({ action: e.target.value }) }} /></Field>
        <Field label="场景"><input className="input-pi text-[12px] min-h-11" value={place} onChange={e => { setPlace(e.target.value); refreshShot({ scene: e.target.value }) }} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="光影"><input className="input-pi text-[12px] min-h-11" value={lighting} onChange={e => setLighting(e.target.value)} /></Field>
          <Field label="运镜"><input className="input-pi text-[12px] min-h-11" value={camera} onChange={e => setCamera(e.target.value)} /></Field>
        </div>
        <Field label="风格"><input className="input-pi text-[12px] min-h-11" value={style} onChange={e => setStyle(e.target.value)} /></Field>
        <Field label="约束"><input className="input-pi text-[12px] min-h-11" value={constraint} onChange={e => setConstraint(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="时长">
            <select className="input-pi !py-2 text-[12px] min-h-11" value={seconds} onChange={e => { setSeconds(e.target.value); onSpecChange?.({ seconds: e.target.value, frame }) }}>
              {['5', '8', '10', '12'].map(s => <option key={s} value={s}>{s} 秒</option>)}
            </select>
          </Field>
          <Field label="画幅">
            <select className="input-pi !py-2 text-[12px] min-h-11" value={frame} onChange={e => { setFrame(e.target.value); onSpecChange?.({ seconds, frame: e.target.value }) }}>
              <option value="16:9">横版 16:9</option>
              <option value="9:16">竖版 9:16</option>
            </select>
          </Field>
        </div>
        <div className="flex gap-1.5">
          {([['lite', '精简'], ['standard', '标准']] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setRichness(k)}
              className={`px-2.5 py-1 rounded-full text-[11px] border ${richness === k ? 'bg-pi-accent text-pi-on-accent border-pi-accent' : 'bg-transparent text-pi-dim border-pi-border-soft'}`}>{label}</button>
          ))}
        </div>
        {richness === 'standard' && (
          <>
            <Field label="记忆点">
              <input className="input-pi text-[12px] min-h-11" value={memory} onChange={e => setMemory(e.target.value)} placeholder="第几秒看见什么" />
            </Field>
            <Field label="时间轴（可改）">
              <textarea className="input-pi text-[12px] min-h-[72px] resize-none" rows={2} placeholder="空着就用镜头卡的起承转合" value={beats} onChange={e => setBeats(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="一句话灵感">
          <input className="input-pi text-[12px] min-h-11" placeholder="谁、在哪、做什么。空着就按当前格子扩写。" value={idea} onChange={e => setIdea(e.target.value)} />
        </Field>
        <PromptSmartFill
          kind="video"
          idea={idea || [subject, action, place].filter(Boolean).join('，')}
          draft={draft}
          onFilled={({ prompt, fields }) => {
            const next = {
              subject: fields?.subject || subject,
              action: fields?.action || action,
              scene: fields?.scene || place,
            }
            if (fields?.subject) setSubject(fields.subject)
            if (fields?.action) setAction(fields.action)
            if (fields?.scene) setPlace(fields.scene)
            const card = VIDEO_GRAMMARS[scene as keyof typeof VIDEO_GRAMMARS] || VIDEO_SCENES[scene]
            const shot = composeVideoScript(card, next)
            const lightingNext = fields?.lighting || shot.lighting
            const cameraNext = fields?.camera || shot.camera
            const styleNext = fields?.style || shot.style
            setLighting(lightingNext)
            setCamera(cameraNext)
            setStyle(styleNext)
            autoShot.current = { lighting: lightingNext, camera: cameraNext, style: styleNext, memory: fields?.memory || shot.memory }
            setMemory(fields?.memory || shot.memory)
            if (fields?.beats) setBeats(fields.beats)
            setOutput(prompt)
            onUsePrompt?.(prompt)
          }}
        />
      </div>

      <button type="button" onClick={generate} className="w-full py-3 min-h-11 rounded-pi-lg bg-gradient-to-r from-pi-accent to-pi-accent2 text-white font-semibold text-sm tracking-wider hover:brightness-110 transition-colors duration-fast">
        <Sparkles className="w-4 h-4 inline mr-2" />生成提示词
      </button>

      {output && (
        <div className="panel !p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold text-pi-text">生成结果</span>
            <div className="flex items-center gap-1.5">
              {onUsePrompt && (
                <button type="button" onClick={() => onUsePrompt(output)} className="btn-tool text-xs">填入出片框</button>
              )}
              <button type="button" onClick={copyToClipboard} className="btn-tool text-xs inline-flex items-center gap-1.5">
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
