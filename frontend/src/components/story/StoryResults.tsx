import { useState } from 'react'
import { downloadApiFile, withFileToken } from '../../api'
import type { StoryAssetRef, StoryBeat, StoryGenerationRun, StoryScene } from '../../types'

const labels: Record<string,string> = { queued:'待执行',running:'正在生成',failed:'生成失败',succeeded:'已生成',degraded:'已生成 · 请核对连续性' }

// 一版的第一个可看产物（图/视频）——版本条与并排对比都靠它取缩略图。
function firstMedia(run: StoryGenerationRun) {
  const assets: StoryAssetRef[] = run.outputAssets || []
  const hit = assets.find(a => (a.type === 'image' || a.type === 'video') && a.url)
  return hit ? { type: hit.type, src: withFileToken(String(hit.url)) } : null
}
// 这一版"发出去的是什么"：模型 / seed / 时间。并排对比时差异就靠这三行对齐着看。
const metaOf = (run: StoryGenerationRun) => [
  { k: '模型', v: `${run.model?.provider || '?'}/${run.model?.id || '?'}` },
  { k: 'seed', v: run.seed != null ? String(run.seed) : '（没记）' },
  { k: '状态', v: labels[run.status] || run.status },
  { k: '生成时间', v: run.createdAt ? new Date(run.createdAt).toLocaleString('zh-CN') : '—' },
  { k: '参数', v: Object.entries(run.params || {}).map(([k2, v2]) => `${k2}=${v2}`).join(' / ') || '—' },
  { k: '耗时', v: run.finishedAt && run.createdAt ? `${Math.max(0, Math.round((new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime()) / 1000))} 秒` : '—' },
]

// 本段结果：**所有版本平铺**，新的在最上面；顶部再加一条版本条 + 并排对比。
// 此前只渲染最新一版，旧版藏在一个 <select> 里——界面明明写着"旧版本会保留"，
// 实际上新的一出来旧的就在视野里消失了。产物本来就全在 scene.outputs 里（只追加不覆盖），
// 这里只是把它们如实摊开。
function Assets({ run, saving, onSave }: { run: StoryGenerationRun; saving: boolean; onSave: (url: string, name: string) => void }) {
  const assets: StoryAssetRef[] = run.outputAssets || []
  if (!assets.length) {
    return <div className="story-output-empty">{run.status === 'running' ? '模型正在生成，完成后结果会出现在这里。' : '这一版没有产出成品。'}</div>
  }
  return <>
    {assets.map((asset, i) => {
      const url = String(asset.url || '')
      const src = url ? withFileToken(url) : ''
      const ext = asset.type === 'video' ? 'mp4' : asset.type === 'image' ? 'png' : 'txt'
      return <div key={asset.id || i} className="story-output">
        {asset.type === 'image' && src && <img src={src} alt="本段生成画面" />}
        {asset.type === 'video' && src && <video src={src} controls playsInline preload="metadata" />}
        {asset.type === 'text' && <div className="story-prose">{String(asset.text || '')}</div>}
        <div className="story-actions">
          {src && <button className="btn-ghost" disabled={saving} onClick={() => onSave(url, `故事-${run.beatId}-v${run.id.slice(0, 6)}-${i + 1}.${ext}`)}>{saving ? '保存中…' : '下载这一版'}</button>}
          {src && <a href={src} target="_blank" rel="noopener noreferrer">打开原文件</a>}
        </div>
      </div>
    })}
  </>
}

export default function StoryResults({ scene, beat, busy, onRerun, onCheck, onDelete, onLocalize, onAdopt, canAdopt }: { scene: StoryScene; beat: StoryBeat; busy?: boolean; onRerun?: (run: StoryGenerationRun) => void; onCheck?: (run: StoryGenerationRun) => void; onDelete?: (run: StoryGenerationRun, opts: { keepFiles: boolean }) => void; onLocalize?: (run: StoryGenerationRun) => void; onAdopt?: (run: StoryGenerationRun) => void; canAdopt?: boolean }) {
  const runs = (scene.outputs || []).filter(run => run.beatId === beat.id).slice().reverse()
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  // 删除是不可逆的：先点「删除」进确认态，确认里还要说清"这一次会不会连文件一起删"。
  // 同一段生成好几版镜头之后，用户要的正是"这几版不要了"——但不能点一下就没了。
  const [confirming, setConfirming] = useState('')
  const [keepFiles, setKeepFiles] = useState(false)
  // 并排对比：选 2~4 版摆在一起看。挑镜头是**比出来的**，一版一版往下滚没法比。
  const [compare, setCompare] = useState<string[]>([])
  const toggleCompare = (id: string) => setCompare(prev => prev.includes(id) ? prev.filter(x => x !== id) : (prev.length >= 4 ? [...prev.slice(1), id] : [...prev, id]))
  const compared = compare.map(id => runs.find(r => r.id === id)).filter(Boolean) as StoryGenerationRun[]
  const save = async (url: string, name: string) => {
    setSaving(true)
    try { setMessage(await downloadApiFile(url, name, setMessage)) }
    catch (e: any) { setMessage(e?.message || '下载未完成，请重试') }
    finally { setSaving(false) }
  }
  const versionNo = (run: StoryGenerationRun) => runs.length - runs.findIndex(r => r.id === run.id)
  return <section className={`story-results${compared.length >= 2 ? ' is-compare' : ''}`} aria-label="生成预览">
    <div className="story-section-head">
      <h2>本段结果</h2>
      <span>{runs.length ? `${runs.length} 个版本 · 全部保留，新的在最上面` : '还没有成品'}</span>
    </div>
    {runs.length > 1 && <div className="story-version-strip">
      <div className="story-version-strip-items">
        {runs.map(run => {
          const media = firstMedia(run)
          const on = compare.includes(run.id)
          return <button
            key={run.id}
            type="button"
            className={`story-version-thumb${on ? ' is-on' : ''}${beat.chosenRunId === run.id ? ' is-chosen' : ''}`}
            onClick={() => toggleCompare(run.id)}
            title={`第 ${versionNo(run)} 版 · ${labels[run.status] || run.status}${run.seed != null ? ` · seed ${run.seed}` : ''}（点击加入/移出对比）`}
          >
            {media?.type === 'video'
              ? <video src={media.src} muted playsInline preload="metadata" />
              : media ? <img src={media.src} alt={`第 ${versionNo(run)} 版`} /> : <span className="story-version-thumb-none">{labels[run.status]?.slice(0, 2) || '—'}</span>}
            <em>v{versionNo(run)}</em>
            {beat.chosenRunId === run.id && <i className="story-version-thumb-badge">采用</i>}
          </button>
        })}
      </div>
      <div className="story-version-strip-side">
        <span className="story-hint">{compare.length ? `已选 ${compare.length} 版对比` : '点缩略图选 2~4 版并排对比'}</span>
        {compare.length > 0 && <button className="btn-ghost" disabled={Boolean(busy)} onClick={() => setCompare([])}>取消对比</button>}
      </div>
    </div>}
    {compared.length >= 2 && <div className="story-compare" aria-label="版本并排对比">
      <div className="story-compare-grid" style={{ gridTemplateColumns: `repeat(${Math.min(compared.length, 4)}, minmax(0,1fr))` }}>
        {compared.map(run => {
          const media = firstMedia(run)
          return <div key={run.id} className="story-compare-cell">
            <div className="story-compare-head">
              <strong>第 {versionNo(run)} 版</strong>
              {beat.chosenRunId === run.id ? <span className="story-version-badge">成片采用</span> : null}
            </div>
            <div className="story-compare-media">
              {media?.type === 'video' ? <video src={media.src} controls muted playsInline preload="metadata" />
                : media ? <img src={media.src} alt={`第 ${versionNo(run)} 版`} />
                  : <div className="story-output-empty">这一版没有可视产物</div>}
            </div>
            <dl className="story-compare-meta">
              {metaOf(run).map(row => <div key={row.k} className="story-compare-row"><dt>{row.k}</dt><dd title={row.v}>{row.v}</dd></div>)}
            </dl>
            {run.degradation?.length ? <p className="story-hint">{run.degradation.join('；')}</p> : null}
            {onAdopt && <button className="btn-ghost" disabled={Boolean(busy) || beat.chosenRunId === run.id} onClick={() => onAdopt(run)}>{beat.chosenRunId === run.id ? '已采用' : '采用这一版'}</button>}
          </div>
        })}
      </div>
    </div>}
    {!runs.length && <div className="story-output-empty">本段还没有成品。检查左侧内容，然后点击“生成当前段落/画面/视频”。</div>}
    {runs.map((run, idx) => <article key={run.id} className="story-version">
      <div className="story-version-head">
        <strong>第 {runs.length - idx} 版</strong>
        {beat.chosenRunId === run.id && <span className="story-version-badge">成片采用</span>}
        <span>{labels[run.status] || run.status} · {run.model?.provider}/{run.model?.id} · {new Date(run.createdAt).toLocaleString('zh-CN')}{run.seed != null ? ` · seed ${run.seed}` : ''}</span>
        <label className="story-version-pick"><input type="checkbox" checked={compare.includes(run.id)} onChange={() => toggleCompare(run.id)} /> 加入对比</label>
      </div>
      {run.degradation?.length ? <div role={run.status === 'failed' ? 'alert' : 'note'} className="story-notice">{run.degradation.join('；')}{run.status === 'failed' ? '。可以更换模型后重试，已有版本仍保留。' : ''}</div> : null}
      <Assets run={run} saving={saving} onSave={save} />
      <div className="story-actions">
        {/* 采用这一版：合成成片时默认用它，不用每段再去挑一次（挑过就别再替他挑） */}
        {onAdopt && <button className="btn-primary" disabled={Boolean(busy) || beat.chosenRunId === run.id} onClick={() => onAdopt(run)}>{beat.chosenRunId === run.id ? '成片采用这一版' : (canAdopt === false ? '采用这一版（非视频片段）' : '采用这一版')}</button>}
        {/* 排队中的版本：给一个人工问一句的入口。「还没好」不是「失败」 */}
        {onCheck && run.status === 'running' && run.taskId && <button className="btn-ghost" disabled={busy} onClick={() => onCheck(run)}>查一次（任务号 {String(run.taskId).slice(0, 12)}）</button>}
        {/* 同参重跑：有了它，一次偶然的好结果才算真的可复现（ComfyUI 里就是"再跑一次同样的图"） */}
        {onRerun && <button className="btn-ghost" disabled={busy} onClick={() => onRerun(run)}>照这版重跑 · 同 seed{run.seed != null ? ` ${run.seed}` : '（这一版没记 seed）'}</button>}
        {/* 外链产物：还挂在会过期的外站地址上。给一个"补下载"的入口——
            本地化契约要求先落到本地，而此前失败之后除了重新生成（再花一次钱）没有补救办法 */}
        {onLocalize && (run.outputAssets || []).some(a => /^https?:/i.test(String(a.url || ''))) &&
          <button className="btn-ghost" disabled={busy} onClick={() => onLocalize(run)}>外链产物 · 下载到本地</button>}
        {/* 删掉不要的那几版：同一段常常生成好几版镜头，留着占地方、挑片段时也碍眼 */}
        {onDelete && confirming !== run.id && <button className="btn-ghost" disabled={busy} onClick={() => { setConfirming(run.id); setKeepFiles(false) }}>删除这一版</button>}
      </div>
      {onDelete && confirming === run.id && <div className="story-confirm" role="alertdialog" aria-label={`确认删除第 ${runs.length - idx} 版`}>
        <p>要删掉<strong>第 {runs.length - idx} 版</strong>（{labels[run.status] || run.status}{run.outputAssets?.length ? ` · ${run.outputAssets.length} 个成品` : ''}）。删记录不可恢复。</p>
        <label><input type="checkbox" checked={keepFiles} disabled={busy} onChange={e => setKeepFiles(e.target.checked)} /> 只从列表里移除，文件留着</label>
        <p className="story-hint">{keepFiles ? '文件会留在工作空间里，可以从「资产」里找回来。' : <>文件也会一起删——但<strong>只要还有别的地方（别的段、别的项目）在用它，就会自动保留</strong>，并告诉你原因。</>}{run.status === 'running' ? ' 这一版还在排队，上游出的片子删掉后就收不回来了。' : ''}</p>
        <div className="story-actions">
          <button className="btn-primary" disabled={busy} onClick={() => { onDelete(run, { keepFiles }); setConfirming('') }}>确认删除</button>
          <button className="btn-ghost" disabled={busy} onClick={() => setConfirming('')}>取消</button>
        </div>
      </div>}
    </article>)}
    {message && <p role="status" className="story-notice">{message}</p>}
  </section>
}
