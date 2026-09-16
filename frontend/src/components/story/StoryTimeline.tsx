import { useMemo, useState } from 'react'
import { downloadApiFile, withFileToken } from '../../api'
import type { StoryFilmBeat, StoryFilmCandidate, StoryFilmPlan } from '../../types'

// 片段时间轴：把"这支片子由哪几段、每段多长、用的是第几版"摊开成一排。
//
// 此前这几件事只能靠「挑片段合成」里的一个下拉猜：一段生成过三版，下拉里只有一行字，
// 没有缩略图、没有时长、也看不出成片到底多少秒。这里做的就是把它们摆出来：
// - 一排缩略图（视频用 preload="metadata" 的静帧），每段标出段号 / 时长 / 可用几版 / 当前用第几版；
// - 每段展开就是这一段的历史版本，点一下换版本——只改 picks（成片顺序数据），**不重跑合成**；
// - 单段导出走现成的 downloadApiFile，文件名带段号与版本号，跟整片下载是同一条通路；
// - 「整段不要」沿用合成面板那套 dropped/picks 逻辑，不另造一份"排除"状态。
//
// 数据说话：探不到时长就写"时长未知"，这一段没有可用版本就写"还没有片段"——
// 不用假时长、假缩略图把格子填满，那样用户会以为这段能拼。

const statusLabel: Record<string, string> = { succeeded: '已生成', degraded: '已生成 · 有降级项' }

// 时长只报到 0.1 秒：产物普遍是 5.184 这种，报 5.2 秒够判断节奏，也不至于满屏小数。
function formatSec(sec?: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '时长未知'
  if (sec < 60) return `${Math.round(sec * 10) / 10} 秒`
  const min = Math.floor(sec / 60)
  return `${min} 分 ${Math.round((sec - min * 60) * 10) / 10} 秒`
}

// 版本号由引擎给（按这一段全部版本从旧到新数）。缺了才退回本地序号，
// 不能反过来：本地只有可用候选，自己数会和「本段结果」里的号对不上。
const versionNoOf = (beat: StoryFilmBeat, cand: StoryFilmCandidate) => cand.versionNo ?? beat.candidates.indexOf(cand) + 1

function extOf(url: string): string {
  const hit = String(url || '').split('?')[0].match(/\.(mp4|webm|mov|mkv|m4v)$/i)
  return hit ? hit[1].toLowerCase() : 'mp4'
}

export default function StoryTimeline({ plan, picks, dropped, busy, onPick, onMove, onDrop, onRestore }: {
  plan: StoryFilmPlan
  picks: { beatId: string; runId: string }[]
  dropped: string[]
  busy: boolean
  onPick: (beatId: string, runId: string) => void
  onMove: (index: number, delta: number) => void
  onDrop: (beatId: string) => void
  onRestore: (beatId: string) => void
}) {
  const [openHistory, setOpenHistory] = useState('')
  const [message, setMessage] = useState('')
  const [broken, setBroken] = useState<string[]>([])
  const byId = useMemo(() => new Map(plan.beats.map(b => [b.beatId, b])), [plan])
  // 时间轴的顺序 = **成片顺序**（picks 的顺序，默认就是分镜顺序）。
  // 按分镜顺序硬排的话，上移/下移改了顺序时间轴却纹丝不动——那这个"时间轴"就是在说假话。
  // 排不进成片的（整段不要 / 没有可用版本）跟在后面，标明"未进成片"，而不是凭空消失。
  const inFilm = picks
    .map(pick => ({ pick, beat: byId.get(pick.beatId) }))
    .filter(item => Boolean(item.beat)) as { pick: { beatId: string; runId: string }; beat: StoryFilmBeat }[]
  const outFilm = plan.beats.filter(b => !inFilm.some(item => item.beat.beatId === b.beatId))

  const durations = inFilm.map(item => (item.pick.runId ? item.beat.candidates.find(c => c.runId === item.pick.runId)?.durationSec : null))
  const known = durations.filter((d): d is number => d != null && Number.isFinite(d))
  const unknownCount = durations.length - known.length
  const totalSec = known.reduce((sum, d) => sum + d, 0)
  const totalText = !inFilm.length
    ? '还没选任何一段进片子'
    : unknownCount === 0
      ? formatSec(totalSec)
      : known.length
        ? `${formatSec(totalSec)}（还有 ${unknownCount} 段没探到时长，未计入）`
        : '时长未知（引擎没探到这几段的时长）'

  const save = async (beat: StoryFilmBeat, cand: StoryFilmCandidate, versionNo: number) => {
    setMessage('')
    // 文件名带段号与版本号：一次导出好几段时，落在下载目录里也要分得清谁是谁
    const name = `成片-第${beat.beatNo}段-v${versionNo}.${extOf(cand.url)}`
    try { setMessage(await downloadApiFile(cand.url, name, setMessage)) }
    catch (e: any) { setMessage(e?.message || '这一段没导出成功，可以再试一次') }
  }

  const segment = (beat: StoryFilmBeat, pick: { beatId: string; runId: string } | null, filmNo: number) => {
    const picked = pick?.runId ? beat.candidates.find(c => c.runId === pick.runId) : undefined
    const isDropped = dropped.includes(beat.beatId)
    const none = !picked
    const src = picked?.url || ''
    const versionNo = picked ? versionNoOf(beat, picked) : 0
    return <li key={beat.beatId} className={`story-film-timeline-seg${none ? ' is-none' : ''}${isDropped ? ' is-dropped' : ''}`}>
      <div className="story-film-timeline-frame">
        {src && !broken.includes(src)
          ? <video className="story-film-timeline-thumb" src={withFileToken(src)} muted playsInline preload="metadata" onError={() => setBroken(prev => [...prev, src])} />
          : <span className="story-film-timeline-blank">{picked ? '这一段预览打不开' : '还没有片段'}</span>}
      </div>
      <div className="story-film-timeline-meta">
        <strong>第 {beat.beatNo} 段</strong>
        {filmNo > 0 && filmNo !== beat.beatNo && <em className="story-film-timeline-slot">成片第 {filmNo} 段</em>}
        {isDropped && <em className="story-film-timeline-slot">不要这一段</em>}
        <span className="story-film-timeline-dur">{src ? formatSec(picked?.durationSec) : '没有片段，算不出时长'}</span>
        <span className="story-film-timeline-vers">{beat.usableCount ? `可用 ${beat.usableCount} 版` : (beat.candidates.length ? `有 ${beat.candidates.length} 版，但都不可用` : '还没有片段')}</span>
        <span className="story-film-timeline-now">{picked ? `当前用第 ${versionNo} 版` : (isDropped ? '这一版没进成片' : '没选进成片')}</span>
        <p className="story-film-timeline-title" title={beat.title}>{beat.title || '（没写内容）'}</p>
        {!beat.usableCount && <p className="story-film-timeline-why">
          {beat.candidates.length
            ? `这一段有 ${beat.candidates.length} 版，但都不是可用的片子（文件已被移走，也不是能下载的链接）`
            : '这一段还没有成功的视频；先给它生成一段视频再合成'}
        </p>}
      </div>
      <div className="story-film-timeline-actions">
        <button className="btn-ghost story-film-timeline-history-btn" disabled={busy} aria-expanded={openHistory === beat.beatId}
          aria-label={`第 ${beat.beatNo} 段用哪一版`}
          onClick={() => setOpenHistory(prev => prev === beat.beatId ? '' : beat.beatId)}>
          版本历史（{beat.candidates.length}）
        </button>
        {picked && !isDropped && <button className="btn-ghost story-film-timeline-export" disabled={busy}
          onClick={() => void save(beat, picked, versionNo)}>
          导出这一段
        </button>}
        {!isDropped && filmNo > 0 && <>
          <button className="btn-ghost" disabled={busy || filmNo <= 1} onClick={() => onMove(filmNo - 1, -1)}>上移</button>
          <button className="btn-ghost" disabled={busy || filmNo >= inFilm.length} onClick={() => onMove(filmNo - 1, 1)}>下移</button>
        </>}
        {!isDropped && <button className="btn-ghost" disabled={busy} onClick={() => onDrop(beat.beatId)}>整段不要</button>}
        {isDropped && <button className="btn-ghost" disabled={busy} onClick={() => onRestore(beat.beatId)}>加回来</button>}
      </div>
      {openHistory === beat.beatId && <ul className="story-film-timeline-history" aria-label={`第 ${beat.beatNo} 段的历史版本`}>
        {/* 新的在最上面，和「本段结果」一个方向；版本号也跟着那边走 */}
        {[...beat.candidates].reverse().map(c => {
          const vNo = versionNoOf(beat, c)
          const current = Boolean(pick?.runId) && pick?.runId === c.runId
          return <li key={c.runId} className={`story-film-timeline-ver${current ? ' is-on' : ''}`}>
            <button className="btn-ghost story-film-timeline-pick" disabled={busy || !c.localable || current}
              aria-label={`第 ${beat.beatNo} 段用第 ${vNo} 版`}
              onClick={() => onPick(beat.beatId, c.runId)}>
              {current ? '正在用这一版' : '用这一版'}
            </button>
            <span className="story-film-timeline-ver-label">
              第 {vNo} 版 · {statusLabel[c.status] || c.status}{c.seed != null ? ` · seed ${c.seed}` : ''}
              {c.chosen ? ' ·（你在本段结果里采用过）' : ''}
            </span>
            <span className="story-film-timeline-ver-note">
              {c.durationSec != null ? formatSec(c.durationSec) : (c.exists ? '时长未知' : '外链，还没下载到本地')}
              {c.exists ? '' : ' · 外链（合成时先下载到本地）'}
              {c.localable ? '' : ' · 不可用（本地文件没了，也不是能下载的链接）'}
            </span>
          </li>
        })}
      </ul>}
    </li>
  }

  return <div className="story-film-timeline" aria-label="片段时间轴">
    <div className="story-film-timeline-head">
      <strong className="story-film-timeline-name">片段时间轴</strong>
      <span className="story-film-timeline-count">进成片 {inFilm.length} 段 · 分镜共 {plan.total} 段（有可用版本 {plan.usable} 段）</span>
      <span className="story-film-timeline-total">总时长 {totalText}</span>
    </div>
    <p className="story-hint">
      顺序就是成片里的先后<strong>（默认与分镜顺序一致）</strong>；点「版本历史」换这一段用第几版，
      只改这一版的选用，<strong>不会重跑合成</strong>。版本号跟「本段结果」里一致（最新的号最大）。
    </p>
    {!plan.beats.length
      ? <p className="story-hint">这个项目还没有分镜段落。</p>
      : <ol className="story-film-timeline-track">
        {inFilm.map((item, i) => segment(item.beat, item.pick, i + 1))}
        {outFilm.map(beat => segment(beat, null, 0))}
      </ol>}
    {message && <p role="status" className="story-notice">{message}</p>}
  </div>
}
