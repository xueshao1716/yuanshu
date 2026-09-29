import { useEffect, useId } from 'react'
import { Play, Square, LoaderCircle } from 'lucide-react'
import { useCallActive } from '../realtime/use-call-active'
import { speech, useSpeech, useAutoSpeech, setAutoSpeech, useSpeechOptions, setSpeechMode,
  refreshSpeechOptions, deviceSpeechSupported, useDeviceVoices, setDeviceVoice } from '../lib/speech'
import './speech-settings.css'

const previewId = 'speech-settings-preview'
export function SpeechSettings() {
  const id = useId(), callActive = useCallActive(), enabled = useAutoSpeech()
  const state = useSpeech(), options = useSpeechOptions(), device = useDeviceVoices()
  const previewing = state.id === previewId && ['loading', 'speaking', 'paused'].includes(state.status)
  const isCloud = options.mode === 'cloud'
  useEffect(() => () => { if (speech.getSnapshot().id === previewId) speech.stop() }, [])
  return <div className="speech-settings">
    <div className="speech-auto-row">
      <div><strong>自动朗读</strong><p id={`${id}-auto-hint`}>文字边生成，声音按句跟读；仅本次打开有效。</p></div>
      <button type="button" className="speech-switch" role="switch" aria-checked={enabled} aria-label="自动朗读新回复"
        aria-describedby={`${id}-auto-hint`} disabled={callActive || !speech.streamingSupported} onClick={() => setAutoSpeech(!enabled)}>
        <span aria-hidden="true"><i /></span>
      </button>
    </div>
    <div className="speech-field">
      <label htmlFor={`${id}-model`}>朗读模型</label>
      <select id={`${id}-model`} aria-label="朗读通道" disabled={callActive} value={options.mode}
        onChange={e => setSpeechMode(e.target.value as 'device' | 'cloud')}>
        <option value="device" disabled={!deviceSpeechSupported}>设备朗读 · 系统引擎{!deviceSpeechSupported ? '（不支持）' : ''}</option>
        <option value="cloud">阶跃云端{options.model ? ` · ${options.model}` : ''}</option>
      </select>
    </div>
    <div className="speech-field">
      {isCloud ? <>
        <span className="speech-field-label">朗读音色</span>
        <div className="speech-fixed-voice"><strong>{options.voiceLabel || options.voice || '等待通道就绪'}</strong><span>与语音通话使用同款音色</span></div>
      </> : <>
        <label htmlFor={`${id}-voice`}>朗读音色</label>
        <select id={`${id}-voice`} aria-label="朗读音色" disabled={callActive || !deviceSpeechSupported} value={device.selected}
          onChange={e => setDeviceVoice(e.target.value)}>
          <option value="">自动选择中文音色</option>
          {device.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name} · {voice.lang}</option>)}
        </select>
        <p className="speech-hint">{device.voices.length ? '来自设备已安装的音色，选择会保存在本机。' : '系统尚未提供音色列表，将使用默认中文朗读。'}</p>
      </>}
    </div>
    <div className="speech-preview-row">
      <button type="button" className="speech-preview" aria-label={previewing ? '停止试听' : '试听声音'} disabled={callActive || !speech.supported}
        onClick={() => previewing ? speech.stop() : speech.speak(previewId, '你好，我是小语。很高兴与你聊天。')}>
        {previewing ? state.status === 'loading' ? <LoaderCircle size={16} className="animate-spin" /> : <Square size={16} /> : <Play size={16} />}
        {previewing ? state.status === 'loading' ? '准备中 · 点击取消' : '停止试听' : '试听声音'}
      </button>
      <span>只影响回复朗读，不改变通话。</span>
    </div>
    {callActive && <p role="status" className="speech-hint">通话中，结束通话后可调整朗读设置。</p>}
    {isCloud && <div className="speech-notice">
      {options.loading ? <p role="status">检查语音通道…</p> : !options.available ? <>
        <p role="status">{options.error}</p><button type="button" className="speech-retry" onClick={() => void refreshSpeechOptions()}>重试检测</button>
      </> : null}
      {options.available && !speech.streamingSupported && <p role="status">当前通道暂不支持流式跟读，可在回复完成后点击朗读。</p>}
      <p>自动跟读优先响应速度；手动朗读保留整段合成音质。</p>
      <p>正文发送给阶跃，按通道计费；试听也会请求语音。</p>
    </div>}
    {state.error && (enabled || state.id === previewId) && <p role="status" className="speech-error">{state.error}</p>}
  </div>
}
