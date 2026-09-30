import { useId } from 'react'
import type { VoiceModel } from '../realtime/ticket'
import { callError } from '../realtime/errors'

type Props = { models: VoiceModel[]; modelKey: string; setModelKey: (key: string) => void
  loading: boolean; error: string; retry: () => void; locked: boolean }
export default function VoiceModelPicker({ models, modelKey, setModelKey, loading, error, retry, locked }: Props) {
  const id = useId(), selected = models.some(m => m.modelKey === modelKey)
  return <div className="voice-model-picker" aria-busy={loading}>
    <label htmlFor={id}>通话模型</label>
    <select id={id} aria-describedby={`${id}-hint`} disabled={locked || loading || !!error || !models.length}
      value={selected ? modelKey : ''} onChange={e => setModelKey(e.target.value)}>
      {!selected && <option value="" disabled>{loading ? '正在加载…' : '请选择实时通话模型'}</option>}
      {models.map(m => <option key={m.modelKey} value={m.modelKey}>{m.name}（{m.provider}）</option>)}
    </select>
    <p id={`${id}-hint`} className="voice-secondary" role="status">{error ? `模型列表加载失败。${callError(error)}`
      : loading ? '正在读取已配置的实时通话模型…'
        : !models.length ? '尚无已配置的实时通话模型，请到模型管理配置阶跃通道后刷新。'
          : !selected ? '原模型已不可用，请重新选择；不会自动换用其他模型。'
            : locked ? '通话中模型已锁定，挂断后可更换。'
              : '仅列出已配置且已接入通话协议的模型；目前支持 StepAudio 2.5。连接状态以开始通话为准。'}</p>
    {!locked && <button type="button" className="voice-text-button touch-hit" disabled={loading} onClick={retry}>刷新模型列表</button>}
  </div>
}
