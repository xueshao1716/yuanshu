import useSWR from 'swr'
import { SoulApi } from './api'
import { api } from '../api'

type EmotionState = { label?: string; primary?: string; valence?: number; arousal?: number; dominance?: number; intensity?: number }

/**
 * 语气来源（2026-10-25，只读）。
 *
 * 这里原来是一个"语气档"开关：选预设或写一句话，注入系统提示词。
 * 但它和元枢的产品方向相反——**灵魂主导**：语气应该由人格定义（tone/价值观/边界/禁忌）、
 * 11 维基因、当前情绪、关系基调共同决定，不该被人往提示词里塞一句话就改。
 * 所以开关拆了，换成这张只读说明：让她自己"由什么长成现在这样"看得见。
 */
export default function ToneSources() {
  const persona = useSWR('soul-persona', SoulApi.persona)
  const genome = useSWR('soul-genome', SoulApi.genome)
  const emotion = useSWR('soul-emotion', () => api<{ state: EmotionState }>('/api/companion/emotion'), { refreshInterval: 60000 })

  const def: any = persona.data?.definition || {}
  const tones: string[] = Array.isArray(def.tone) ? def.tone : []
  const values: string[] = Array.isArray(def.values) ? def.values : []
  const genes = genome.data?.genes || {}
  const topGenes = Object.entries(genes)
    .map(([k, v]: any) => ({ name: k, baseline: Number(v?.baseline ?? 0), expression: Number(v?.expression ?? 0) }))
    .sort((a, b) => Math.abs(b.expression || b.baseline) - Math.abs(a.expression || a.baseline))
    .slice(0, 4)
  const emo = emotion.data?.state

  return (
    <div className="tone-sources">
      <p className="tone-sources-line">
        语气不是开关，是这几样东西一起长出来的。<strong>没有"改一句话就换口吻"的入口</strong>——要改口吻，
        改人格定义（要人批准），或者等基因与情绪自己变。
      </p>

      <div className="tone-sources-grid">
        <section>
          <h4>人格定义 · 说话</h4>
          {tones.length ? (
            <ul>{tones.slice(0, 4).map((t, i) => <li key={i}>{t}</li>)}</ul>
          ) : <p className="tone-sources-dim">还没写（用默认定义）</p>}
        </section>

        <section>
          <h4>人格定义 · 在意什么</h4>
          {values.length ? (
            <ul>{values.slice(0, 3).map((t, i) => <li key={i}>{t}</li>)}</ul>
          ) : <p className="tone-sources-dim">还没写</p>}
        </section>

        <section>
          <h4>基因（表达最强的几维）</h4>
          {topGenes.length ? (
            <ul>{topGenes.map((g) => (
              <li key={g.name}>{g.name}：{g.expression ? g.expression.toFixed(2) : g.baseline.toFixed(2)}</li>
            ))}</ul>
          ) : <p className="tone-sources-dim">读取中…</p>}
        </section>

        <section>
          <h4>此刻的情绪</h4>
          {emo ? (
            <ul>
              <li>{emo.label || emo.primary || '—'}{typeof emo.intensity === 'number' ? `（强度 ${Math.round(emo.intensity * 100)}%）` : ''}</li>
              {typeof emo.valence === 'number' && (
                <li className="tone-sources-dim">
                  V {emo.valence.toFixed(2)} · A {(emo.arousal ?? 0).toFixed(2)} · D {(emo.dominance ?? 0).toFixed(2)}
                </li>
              )}
            </ul>
          ) : <p className="tone-sources-dim">没有读数</p>}
        </section>
      </div>
    </div>
  )
}
