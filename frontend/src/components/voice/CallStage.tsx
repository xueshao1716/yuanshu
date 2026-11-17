import { useEffect, useRef, useState } from 'react'
import { createSiriWave } from '../../realtime/siri-wave.mjs'
import { smoothBands, ZERO_BANDS } from '../../realtime/levels.mjs'

type Bands = { level: number; low: number; mid: number; high: number }
export type CallLevels = () => { mic: Bands; out: Bands } | null

// 球里的声波只读真实音量：听你说时用麦克风，回复时用回放；静音/连接中没有音量就不起伏。
// 连接中收成一颗光点，就绪后展开。没有 WebGL 或系统要求减少动态时，退回原来的 CSS 光球。
const OPEN = new Set(['listening', 'hearing', 'replying', 'muted'])
export default function CallStage({ state, levels }: { state: string; levels?: CallLevels }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state), levelsRef = useRef(levels)
  stateRef.current = state; levelsRef.current = levels
  const [wave, setWave] = useState(false)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const renderer = createSiriWave(canvas)
    if (!renderer) return
    setWave(true)
    let raf = 0, bands: Bands = ZERO_BANDS, res = OPEN.has(stateRef.current) ? 1 : 0, settled = ''
    const t0 = performance.now()
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const s = stateRef.current, open = OPEN.has(s)
      // 光点是静止的：收拢完成后只画一次，直到状态变化，省电。
      if (!open && res < 0.002 && settled === s) return
      const lv = levelsRef.current?.()
      const source = s === 'replying' ? lv?.out : s === 'listening' || s === 'hearing' ? lv?.mic : null
      bands = smoothBands(bands, source || ZERO_BANDS)
      res += ((open ? 1 : 0) - res) * 0.08
      if (!open && res < 0.002) { res = 0; settled = s }
      renderer.draw((now - t0) / 1000, { ...bands, res, low: open ? bands.low : 0.4 })
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); renderer.destroy(); setWave(false) }
  }, [])
  return <div className="voice-stage" aria-label="动态通话画面" role="img" data-state={state}>
    <div className="voice-orbit voice-orbit-outer" aria-hidden="true" />
    <div className="voice-orbit voice-orbit-inner" aria-hidden="true" />
    <div className="voice-orb" aria-hidden="true" data-wave={wave ? '' : undefined}>
      {!wave && <><div className="voice-orb-flow" /><div className="voice-orb-light" /></>}
      <canvas ref={canvasRef} className="voice-orb-wave" />
      <div className="voice-orb-glass" />
    </div>
  </div>
}
