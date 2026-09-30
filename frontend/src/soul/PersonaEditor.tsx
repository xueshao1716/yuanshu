import { useEffect, useId, useState } from 'react'
import useSWR from 'swr'
import { SoulApi, type Definition, type Persona } from './api'
import { personaPatch, normalizeDraft, PERSONA_FIELDS, DESIGN_FIELDS } from './draft.mjs'
import { Block, errorText, fieldLabels, formatValue, LoadState } from './shared'

export default function PersonaEditor({ sessionId, busy, run, onDirtyChange, designMode = false }: {sessionId: string; busy: boolean; run: (work: () => Promise<unknown>) => Promise<boolean>; onDirtyChange:(dirty:boolean)=>void; designMode?:boolean}) {
  const state = useSWR('soul-persona', SoulApi.persona)
  const fieldId = useId()
  const [base, setBase] = useState<Persona | null>(null), [draft, setDraft] = useState<Definition>({})
  const [reason, setReason] = useState(''), [preview, setPreview] = useState(false), [error, setError] = useState('')
  useEffect(() => {if (!base && state.data && !state.data.problems.length) {setBase(state.data); setDraft(structuredClone(state.data.definition))}}, [state.data, base])
  const changes = base ? personaPatch(base.definition, normalizeDraft(draft)) : {}
  const dirty = !!Object.keys(changes).length
  const fields = PERSONA_FIELDS.filter(key => DESIGN_FIELDS.includes(key) === designMode)
  const multiline = (key:string) => DESIGN_FIELDS.includes(key) || ['inner','tone','values','boundaries','taboos','growth'].includes(key)
  useEffect(()=>{onDirtyChange(dirty)},[dirty,onDirtyChange])
  const stale = !!base && state.data?.revision !== base.revision
  const blocked = !base?.revision || !!state.error || !!state.data?.problems.length || state.data?.source !== 'file' || stale
  const reset = () => {if (state.data && !state.data.problems.length) {setBase(state.data); setDraft(structuredClone(state.data.definition)); setPreview(false); setError('')}}
  const save = async () => {
    if (!base || blocked || busy) return
    setError('')
    const ok = await run(async () => {try {await SoulApi.apply({definition: changes, expectedRevision: base.revision, sessionId, reason}); const fresh = await state.mutate(); if(fresh) {setBase(fresh); setDraft(structuredClone(fresh.definition))}; setPreview(false); setReason('')} catch(e) {setError(errorText(e)); throw e}})
    if (!ok) void state.mutate()
  }
  return <>
    <LoadState error={state.error} loading={state.isLoading} retry={state.mutate} />
    {!!state.data?.problems.length && <p role="alert" className="soul-notice">{state.data.problems.join('；')}。读取恢复前不能保存。</p>}
    {stale && <p role="alert" className="soul-notice">人格已被其他页面修改。草稿仍保留，请先核对当前内容，再重新载入。</p>}
    <Block title={designMode ? '人物设计' : '人格定义'} hint={designMode ? '外貌与服装跟随同一份人格定义。留空表示尚未设定，不替你猜人物；批准只更新设计描述，不会自动重画四组立绘。身份和形象共用一个草稿，预览会列出全部修改。' : '这是现有人格文件的编辑入口。草稿不会自动保存；每次提交都要查看差异、人工确认，并留下修订记录。'}>
      <fieldset disabled={busy || blocked} className="soul-form">
        {fields.map(key => <label key={key} htmlFor={`${fieldId}-${key}`} className={multiline(key) ? 'soul-wide' : ''}>
          <span id={`${fieldId}-${key}-label`}>{fieldLabels[key]}</span>
          {multiline(key) ? <><textarea id={`${fieldId}-${key}`} aria-labelledby={`${fieldId}-${key}-label`} rows={3} maxLength={DESIGN_FIELDS.includes(key) ? 4000 : undefined} value={formatValue(draft[key])} onChange={e => {setDraft({...draft, [key]: e.target.value}); setPreview(false)}} />{!DESIGN_FIELDS.includes(key) && key !== 'growth' && <small>每行一条</small>}{key === 'scenarioOutfits' && <small>每行描述一个场景，例如工作、休闲或正式场合；不会自动切换素材。</small>}</> : <input id={`${fieldId}-${key}`} aria-labelledby={`${fieldId}-${key}-label`} type={key === 'age' ? 'number' : 'text'} min={key === 'age' ? 16 : undefined} max={key === 'age' ? 99 : undefined} value={formatValue(draft[key])} onChange={e => {setDraft({...draft,[key]:key === 'age' && e.target.value !== '' ? Number(e.target.value) : e.target.value}); setPreview(false)}} />}
        </label>)}
      </fieldset>
      <div className="soul-actions"><button disabled={busy || blocked || !Object.keys(changes).length} onClick={() => setPreview(true)}>查看差异 · {Object.keys(changes).length} 项</button><button disabled={busy || !state.data || !!state.data.problems.length} onClick={reset}>放弃草稿并载入当前版本</button></div>
    </Block>
    {preview && <Block title="确认修改内容" hint="下面是当前版本与草稿的差异。提交后，本页会出现人工确认卡，60秒内未确认将取消。">
      {Object.entries(changes).map(([key,value]) => <div className="soul-diff" key={key}><h4>{fieldLabels[key]}</h4><div><span>原来</span><p>{formatValue(base?.definition[key]) || '（空）'}</p></div><div><span>修改为</span><p>{formatValue(value) || '（空）'}</p></div></div>)}
      <label className="soul-field">修改理由<textarea value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} /></label>
      <button className="soul-primary" disabled={busy || blocked || !sessionId || !reason.trim()} onClick={() => void save()}>{busy ? '等待人工确认…' : '提交并请求人工确认'}</button>
      {!sessionId && <p>请在页面上方选择确认记录所属会话。</p>}
    </Block>}
    {error && <p role="alert" className="soul-notice">{error}。草稿已保留。</p>}
    <details className="soul-details"><summary>查看当前定义渲染的人格文本</summary><p className="soul-hint">这是当前定义的预览，不代表已启动的每个会话都重新载入了人格。</p><p className="soul-preserve">{state.data?.rendered || '尚未读取'}</p></details>
  </>
}
