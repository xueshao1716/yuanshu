import { useState } from 'react'
import { KnowledgeApi, knowledgeError, type KnowledgeJob } from './api'

export default function KnowledgeSource({ revision, refreshed, parent }: { revision: number; refreshed: () => Promise<unknown>; parent?: KnowledgeJob }) {
  const [kind, setKind] = useState('file'), [value, setValue] = useState(''), [session, setSession] = useState(''), [runId, setRunId] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  return <details className="border-t border-pi-border-soft pt-3">
    <summary className="min-h-11 cursor-pointer py-2 font-medium">{parent?.state==='committed' ? '更正这条已入库知识' : parent ? '为这项任务补充证据' : '补充一份来源'}</summary>
    {parent?.state==='committed'&&<p className="text-pi-dim leading-6">提交可核对的新来源，形成待核查的更正记录。通过核查前，原条目不被替换；替换后仍保留原始记录，不把模型自述当作已验证事实。</p>}
    <form className="space-y-3 py-2" onSubmit={async e => {
      e.preventDefault(); if (busy) return; setBusy(true); setError(''); setMessage('')
      try {
        const source = kind === 'file' ? { kind, path: value.trim() } : kind === 'url' ? { kind, url: value.trim() } : kind === 'method' ? { kind, path: value.trim(), runId: runId.trim(), sessionId: session.trim() } : { kind, runId: value.trim(), sessionId: session.trim() }
        const job = parent ? await KnowledgeApi.supplement(parent.id, source, parent.revision, revision) : await KnowledgeApi.enqueue(source, revision)
        setMessage(`已登记：${job.title}。${parent ? '已关联原任务，仍需核查。' : '登记不等于已经提炼或验证。'}`); setValue('')
        await refreshed()
      } catch (err) { setError(knowledgeError(err)) } finally { setBusy(false) }
    }}>
      <fieldset disabled={busy} className="space-y-3">
      <legend className="sr-only">{parent ? '任务补证来源' : '知识来源'}</legend>
      <p className="text-pi-dim leading-6">只处理你授权的资料。已完成任务会自动登记；网页和外部模型仍需单独授权。</p>
      <label className="block">来源类型<select className="input-pi mt-1 w-full min-h-11" value={kind} onChange={e => {setKind(e.target.value); setValue(''); setMessage('')}}>
        <option value="file">工作空间内的文件</option><option value="run">已结束的任务记录</option><option value="url">获准的 HTTPS 网页</option>
        {!parent && <option value="method">固定契约验证的方法资料</option>}
      </select></label>
      <label className="block">{kind === 'file' ? '相对工作空间的文件路径' : kind === 'method' ? 'JSON 验证清单的相对路径' : kind === 'url' ? '完整网页地址' : '任务 ID'}
        <input className="input-pi mt-1 w-full min-h-11" required value={value} onChange={e => setValue(e.target.value)} maxLength={2048} type={kind === 'url' ? 'url' : 'text'} />
      </label>
      {kind === 'method' && <><label className="block">产物所属任务 ID<input required className="input-pi mt-1 w-full min-h-11" value={runId} onChange={e => setRunId(e.target.value)} /></label>
        <p className="text-pi-dim leading-6">仅支持 json-contract-v1：对本次真实 JSON 产物进行只读字段核对，不执行资料命令，不替代任务或天团验收。清单、原文、产物都须已获准读取。</p>
        <details><summary className="min-h-11 py-2 cursor-pointer">验证清单格式</summary><pre className="overflow-x-auto text-xs whitespace-pre-wrap">{'{"version":1,"checker":"json-contract-v1","sourcePath":"docs/method.txt","offset":0,"length":20,"artifactPath":"生成物/result.json","assertions":[{"pointer":"/port","equals":8787}]}'}</pre><p className="text-pi-dim">offset 和 length 按原文字符位置填写；检查仅证明所列字段在当前环境满足契约。</p></details></>}
      {['run', 'method'].includes(kind) && <label className="block">所属会话 ID<input required className="input-pi mt-1 w-full min-h-11" value={session} onChange={e => setSession(e.target.value)} /></label>}
      {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <button className="btn-primary min-h-11 px-4 disabled:opacity-50" disabled={busy}>{busy ? '正在登记…' : '提交到知识队列'}</button>
      </fieldset>
    </form>
  </details>
}
