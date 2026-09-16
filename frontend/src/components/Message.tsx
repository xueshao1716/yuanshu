import { lazy, Suspense, useMemo, useState } from 'react'
import { TOOL_COLORS, COLOR_ERROR, COLOR_TOOL_FALLBACK } from '../theme/palettes'
import { Brain, FileText, Check, X, Pencil, ChevronRight, Square, Info, Download, RefreshCw } from 'lucide-react'
const Markdown = lazy(() => import('./Markdown'))

function LazyMarkdown({ text }: { text: string }) {
  return <Suspense fallback={<div className="text-pi-dim2 text-xs py-2">渲染中…</div>}><Markdown text={text} /></Suspense>
}

// ② 引擎标签：与 engine/engine-pair.mjs 里的名字保持一致，别在这里另起一套叫法
const ENGINE_LABEL: Record<string, string> = {
  yuanshu: '元枢自制循环',
  pi: '兼容适配器(pi)',
  dsh: '外部执行引擎(dsh)',
}

import { downloadApiFile, withFileToken } from '../api'
import { scrapeVideos, dedupeMediaUrls, mediaPathKey } from '../lib/media-embed'
import { artifactName, fileNameFromUrl } from '../lib/artifact-name'
import { fmtMsgTime } from '../lib/fmt-time'
import type { ChatMessage, RunningTool, ToolStatus } from '../types'
import { AgentWorkflow } from './AgentWorkflow'

// 兼容两种来源：流式 RunningTool / 历史消息里的 ToolCall（无 running 态）
function ToolCard({ tool }: { tool: Partial<RunningTool> & { name: string } }) {
  const [open, setOpen] = useState(false)
  const status: ToolStatus = (tool as any).status || (tool.running ? 'running' : tool.isError ? 'error' : 'completed')
  const running = status === 'running'
  const isError = status === 'error'
  const icon = tool.name === 'bash' ? '$' : tool.name === 'read' ? 'R' : tool.name === 'write' ? 'W' : tool.name === 'edit' ? 'E' : '⚙'
  const tc = isError ? COLOR_ERROR : (TOOL_COLORS[tool.name] || COLOR_TOOL_FALLBACK)
  let argsText = tool.argsText || ''
  try {
    const a = typeof tool.argsText === 'string' ? JSON.parse(tool.argsText) : tool.argsText
    if (a && typeof a === 'object') argsText = a.command || a.path || a.content?.slice?.(0, 80) || JSON.stringify(a).slice(0, 80)
  } catch { /* 保持原文本 */ }

  return (
    <div className={`my-2 rounded-xl border overflow-hidden text-[13px] bg-pi-bg1/60 transition-[background-color,border-color,box-shadow] duration-200 ${isError ? 'border-pi-danger/40' : 'border-pi-border-soft/60 hover:border-pi-border hover:shadow-md hover:shadow-black/10'}`}>
      <div
        className="press w-full flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-pi-bg-hover/60 active:bg-pi-bg-active/50 transition-colors text-left"
        style={{ boxShadow: `inset 3px 0 0 ${tc}` }}
        onClick={() => setOpen(!open)}
      >
        <span className="w-5 h-5 rounded-pi-sm flex items-center justify-center text-white text-[12px] font-bold flex-shrink-0 font-mono" style={{ backgroundColor: tc, boxShadow: 'var(--pi-shadow-sm)' }}>{icon}</span>
        <span className="font-mono font-semibold text-[11px] px-1.5 py-0.5 rounded-pi-sm flex-shrink-0" style={{ color: tc, background: `${tc}14` }}>{tool.name}</span>
        <span className="text-pi-dim truncate flex-1 font-mono text-[12px]">{argsText}</span>
        {status === 'running' ? (
          <span className="flex items-center gap-1.5 text-pi-accent text-[11px] flex-shrink-0">
            <span className="w-3 h-3 rounded-full border-[1.5px] border-pi-accent/25 border-t-pi-accent animate-spin" />
            运行中
          </span>
        ) : status === 'canceled' ? (
          <span className="flex items-center gap-1.5 text-pi-dim2 text-[11px] flex-shrink-0">
            <Square className="w-3 h-3" /> 已停止
          </span>
        ) : (
          <span className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${isError ? 'bg-pi-danger/15 text-pi-danger' : 'bg-pi-success/15 text-pi-success'}`}>
            {isError ? <X className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
          </span>
        )}
        <ChevronRight className={`w-3 h-3 text-pi-dim2 flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </div>
      {running && <div className="h-[2px] w-full overflow-hidden"><div className="tool-progress" /></div>}
      {open && (
        <div className="border-t border-pi-border-soft bg-black/20">
          <div className="font-mono text-[12px] text-pi-dim whitespace-pre-wrap max-h-56 overflow-auto px-3 py-2 leading-relaxed">
            {tool.output || (status === 'running' ? '(运行中…)' : status === 'canceled' ? '(已停止)' : '(无输出)')}
          </div>
        </div>
      )}
    </div>
  )
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="my-2">
      <div className="inline-flex items-center gap-1.5 text-pi-text text-[11px] font-medium cursor-pointer transition-colors rounded-full px-2.5 py-1 -ml-1 bg-pi-accent/6 border border-pi-accent/12 hover:bg-pi-accent/10"
        onClick={() => setOpen(!open)}>
        <Brain className="w-3 h-3 text-pi-text" />
        {live && (
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pi-accent opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-pi-accent" />
          </span>
        )}
        <span>{live && !open ? '思考中…' : '思考过程'}</span>
        <ChevronRight className={`w-2.5 h-2.5 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </div>
      {open && (
        <section className="thinking-panel" aria-label="思考过程正文">
          <LazyMarkdown text={text} />
        </section>
      )}
    </div>
  )
}

function Attachments({ msg }: { msg: ChatMessage }) {
  const videos = dedupeMediaUrls(msg.videos?.length ? msg.videos : scrapeVideos(msg.text || ''))
  const [downloading, setDownloading] = useState<string | null>(null)
  const [failed, setFailed] = useState<Record<string, boolean>>({})
  const [downloadStatus, setDownloadStatus] = useState<Record<string, string>>({})
  const [downloadErrors, setDownloadErrors] = useState<Record<string, boolean>>({})
  // 下载名遵循命名契约（docs/NAMING.md）：{摘要}_{类型}_{时间戳}-{id}_v版本.mp4
  // 以前取不到本地文件名就回退成 `元枢视频-N.mp4`，所有视频下载下来都同名、互相覆盖。
  //
  // 必须 memo：artifactName 每次都生成新的随机 id，若在 render 里现算，
  // 显示的名字会每帧都变，点下载拿到的也不是刚显示的那个名字。
  const videoKey = videos.join('|')
  const videoNames = useMemo(() => {
    const map = new Map<string, string>()
    videos.forEach(url => map.set(url, fileNameFromUrl(url) || artifactName({ slug: msg.text || '', kind: 'video' })))
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey, msg.text])
  // 播放器下面显示的短标签：全名带时间戳太吵，显示层不承担契约
  const videoLabel = (url: string, index: number) => fileNameFromUrl(url) || `视频 ${index + 1}`
  const videoName = (url: string, index: number) => videoNames.get(url) || fileNameFromUrl(url) || `元枢_视频_${index + 1}.mp4`
  const downloadVideo = async (url: string, index: number) => {
    if (downloading) return
    setDownloading(url)
    setDownloadErrors(state => ({ ...state, [url]: false }))
    const report = (message: string) => setDownloadStatus(state => ({ ...state, [url]: message }))
    try {
      const path = url.includes('/api/ws/file') && !url.includes('download=') ? `${url}&download=1` : url
      report(await downloadApiFile(path, videoName(url, index), report))
    } catch (error: any) {
      setDownloadErrors(state => ({ ...state, [url]: true }))
      report(error?.message === 'Failed to fetch' ? '无法获取视频，请检查连接；也可打开原文件保存' : error?.message || '下载未完成，请重试')
    }
    finally { setDownloading(null) }
  }
  return (
    <>
      {msg.images?.map((src, i) => (
        <div key={'img' + i} className="my-1.5">
          <img src={withFileToken(src)} alt={`图片${i + 1}`} loading="lazy" className="max-w-[320px] max-h-[280px] rounded-pi-lg border border-pi-border-soft object-cover cursor-zoom-in" onClick={(e) => window.open((e.target as HTMLImageElement).src, '_blank')} />
        </div>
      ))}
      {msg.audios?.map((url, i) => (
        <div key={'aud' + i} className="my-1.5"><audio controls src={withFileToken(url)} className="max-w-full h-9" /></div>
      ))}
      {videos.map((url, index) => (
        <div key={'vid:' + mediaPathKey(url)} className="my-2 w-full max-w-[560px]">
          <video controls playsInline preload="metadata" src={withFileToken(url)} onError={() => setFailed(state => ({ ...state, [url]: true }))} className="w-full aspect-video rounded-pi-lg border border-pi-border-soft bg-black" />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] text-pi-dim2">{failed[url] ? '视频暂时无法播放，可直接下载原文件' : videoLabel(url, index)}</span>
            <button type="button" className="btn-tool inline-flex min-h-11 shrink-0 items-center gap-1.5 px-2.5" onClick={() => downloadVideo(url, index)} disabled={Boolean(downloading)} aria-label={`下载${videoName(url, index)}`} title="下载视频">
              {downloading === url ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              <span className="text-[11px]">{downloading === url ? '保存中…' : '下载视频'}</span>
            </button>
          </div>
          {downloadStatus[url] && <div role={downloadErrors[url] ? 'alert' : 'status'} className={`mt-2 text-xs leading-relaxed ${downloadErrors[url] ? 'text-pi-danger' : 'text-pi-dim'}`}>{downloadStatus[url]}</div>}
          {downloadStatus[url] && !downloading && <div className="flex flex-wrap gap-4 text-xs text-pi-accent"><a className="inline-flex min-h-11 items-center underline" href={withFileToken(url.includes('/api/ws/file') ? `${url}&download=1` : url)} download={videoName(url, index)} target="_blank" rel="noopener noreferrer">打开原文件保存</a><a className="inline-flex min-h-11 items-center" href="#/downloads">查看下载记录</a></div>}
        </div>
      ))}
      {msg.files?.map((f, i) => (
        <div key={'file' + i} className="my-1.5 inline-flex items-center gap-2 px-3 py-1.5 rounded-pi-md border border-pi-border bg-pi-bg3/70 text-[13px] max-w-full">
          <FileText className="w-3.5 h-3.5 text-pi-accent flex-shrink-0" />
          <span className="text-pi-text truncate">{f.name || f.path}</span>
        </div>
      ))}
    </>
  )
}

export default function Message({ msg, onEdit, onRetry }: { msg: ChatMessage & { streaming?: boolean }; onEdit?: (text: string) => void; onRetry?: (msg: ChatMessage) => void } & { [k: string]: any }) {
  const isUser = msg.role === 'user'
  const isSystem = msg.role === 'system'
  const streaming = !!(msg as any).streaming
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const canEdit = isUser && !!onEdit && !streaming && msg.id !== '__streaming__' && !msg.id.startsWith('sys')

  // 系统提示条：独立窄条，不进气泡流
  if (isSystem) {
    return (
      <div className="flex justify-center py-1.5">
        <div className="text-[12px] text-pi-info bg-pi-info/8 border border-pi-info/20 rounded-pi-pill px-3 py-1 inline-flex items-center gap-1.5"><Info className="w-3.5 h-3.5" aria-hidden="true" />{msg.text}</div>
      </div>
    )
  }

  if (isUser) {
    // 用户：右侧玻璃气泡 + 小头像
    return (
      <div className="group/msg flex justify-end gap-2 py-2">
        <div className="max-w-[82%] min-w-0 flex flex-col items-end">
          {editing ? (
            <div className="w-full min-w-[280px]">
              <textarea autoFocus rows={3} value={draft} onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setEditing(false); if (draft.trim()) onEdit?.(draft.trim()) } if (e.key === 'Escape') setEditing(false) }}
                className="input-pi text-[13px] resize-none" />
              <div className="flex justify-end gap-2 mt-1.5">
                <button className="btn-tool text-xs" onClick={() => setEditing(false)}>取消</button>
                <button className="btn-primary text-xs px-3 py-1" onClick={() => { setEditing(false); if (draft.trim()) onEdit?.(draft.trim()) }}>重新发送</button>
              </div>
            </div>
          ) : (
            <>
              <Attachments msg={msg} />
              {(msg.text || !msg.files?.length) && (
                <div className="relative msg-bubble msg-bubble-user rounded-[20px] rounded-br-lg px-3.5 py-2 mt-0.5">
                  <span className="whitespace-pre-wrap text-[13px] text-pi-text leading-relaxed">{msg.text}</span>
                </div>
              )}
              <div className="flex items-center gap-2 mt-0.5 px-1">
                {canEdit && (
                  <button className="hov-reveal inline-flex items-center gap-1 text-[11px] text-pi-dim2 hover:text-pi-text transition-colors" title="编辑并重新发送" aria-label="编辑并重新发送"
                    onClick={() => { setDraft(msg.text); setEditing(true) }}><Pencil className="w-3 h-3" /> 编辑</button>
                )}
                {msg.ts && <span className="hov-reveal text-[11px] text-pi-dim2 transition-opacity" title={new Date(msg.ts).toLocaleString('zh-CN', { hour12: false })}>{fmtMsgTime(msg.ts)}</span>}
              </div>
            </>
          )}
        </div>
        <div className="w-6 h-6 rounded-lg bg-pi-accent text-white flex items-center justify-center text-[11px] font-bold flex-shrink-0 mt-0.5">我</div>
      </div>
    )
  }

  // 助手：实底头像，不用渐变
  // 计算工作流阶段
  const hasThinking = !!msg.think
  const hasTools = (msg.tools?.length || 0) > 0
  const hasText = !!msg.text
  const runningTools = msg.tools?.filter(t => t.status === 'running').length || 0
  
  let phase: 'thinking' | 'tools' | 'result' | 'idle' = 'idle'
  if (streaming) {
    if (hasTools && runningTools > 0) phase = 'tools'
    else if (hasText) phase = 'result'
    else phase = 'thinking'
  }

  return (
    <div className="group/msg flex gap-2 py-2 msg-assistant">
      <div className="w-7 h-7 rounded-lg bg-pi-accent flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0 mt-0.5"
        style={{ boxShadow: 'var(--pi-shadow-sm)' }}>语</div>
      <div className="min-w-0 flex-1">
        {/* ② 流式期间就把"谁在干活"摆出来：换模型换引擎这件事，不该等回复完了才知道 */}
        {streaming && msg.engine && (
          <div className="mb-1.5">
            <span className="px-1.5 py-0.5 rounded-pi-pill bg-pi-accent/10 text-pi-accent text-[10px]"
              title={msg.engineReason || '本轮由这个引擎主驾'}>主驾 {ENGINE_LABEL[msg.engine] || msg.engine}</span>
          </div>
        )}
        {/* 工作流可视化：只在流式中显示 */}
        {streaming && phase !== 'idle' && (
          <div className="mb-3">
            <AgentWorkflow 
              phase={phase}
              thinking={hasThinking}
              toolsRunning={runningTools}
              toolsTotal={msg.tools?.length || 0}
            />
          </div>
        )}
        {msg.notes?.length ? (
          <div className="mb-2 space-y-1">
            {msg.notes.map((n, i) => (
              <div key={i} className="text-[12px] text-pi-info bg-pi-info/8 border border-pi-info/20 rounded-pi-sm px-2.5 py-1 w-fit inline-flex items-center gap-1.5"><Info className="w-3.5 h-3.5" aria-hidden="true" />{n}</div>
            ))}
          </div>
        ) : null}
        {!streaming && <Thinking text={msg.think} live={streaming} />}
        {streaming && msg.think && <Thinking text={msg.think} live={!msg.text} />}
        {msg.tools?.length ? (
          <div className="mb-2">{msg.tools.map((t, i) => <ToolCard key={t.id || i} tool={t} />)}</div>
        ) : null}
        {/* 阶段分区（stream-assembler）：conclusion 存在时，工具前文字在上、结论在工具卡之后；
            历史消息无 conclusion 字段，保持原渲染不变 */}
        {msg.conclusion != null && msg.text ? (
          <div className={"markdown-body-wrapper" + (streaming ? " streaming-caret" : "")}>
            <LazyMarkdown text={msg.text} />
          </div>
        ) : null}
        {msg.conclusion != null
          ? (msg.conclusion ? (
            <div className={"markdown-body-wrapper" + (streaming ? " streaming-caret" : "")}>
              <LazyMarkdown text={msg.conclusion} />
            </div>
          ) : null)
          : (
            <div className={"markdown-body-wrapper" + (streaming ? " streaming-caret" : "")}>
              <LazyMarkdown text={msg.text} />
            </div>
          )}
        <Attachments msg={msg} />
        {/* 失败可见（2026-09-16）：pi 通道的失败不抛异常，只落一条 stopReason=error 的记录。
            以前它被静默丢掉，用户只看到"它不说话 / 变傻了"。现在原因留在历史里并可重试。 */}
        {msg.error ? (
          <div className="my-2 rounded-pi-md border border-pi-danger/40 bg-pi-danger/10 px-3 py-2">
            <div className="flex items-start gap-2">
              <X className="w-3.5 h-3.5 text-pi-danger mt-0.5 flex-shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-[12px] text-pi-text break-words">本轮失败：{msg.error}</div>
                <div className="text-[11px] text-pi-dim2 mt-0.5">失败不藏起来——同一个模型连续失败会自动标冷却，下一轮避开它。</div>
              </div>
            </div>
            {onRetry && (
              <button type="button"
                className="mt-2 inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-pi-sm border border-pi-border-soft hover:border-pi-border text-pi-text"
                onClick={() => onRetry(msg)}><RefreshCw className="w-3 h-3" aria-hidden="true" /> 重试这一条</button>
            )}
          </div>
        ) : null}
        {msg.ts && !streaming && (
          <div className="hov-reveal text-[11px] text-pi-dim2 mt-1 transition-opacity flex items-center gap-2">
            <span title={new Date(msg.ts).toLocaleString('zh-CN', { hour12: false })}>{fmtMsgTime(msg.ts)}</span>
            {/* ② 主驾引擎：换模型会换引擎（非原生通道走元枢自制循环，原生通道走 pi 适配器），
                这件事用户以前完全看不见，只能感觉"它脾气变了"。原因放 title。 */}
            {msg.engine && (
              <span className="px-1.5 py-0.5 rounded-pi-pill bg-pi-accent/10 text-pi-accent text-[10px]"
                title={msg.engineReason || '本轮由这个引擎主驾'}>
                主驾 {ENGINE_LABEL[msg.engine] || msg.engine}
              </span>
            )}
            {/* 回答被重写/换模型过：必须显眼（用户原话："静默换成 agnes 3.0"）。
                同一模型重写 = 「已重写」；换了模型 = 「兜底 <模型>」，title 里写清原因和原本选的模型。 */}
            {msg.switchedModel && (
              <span className="px-1.5 py-0.5 rounded-pi-pill bg-amber-400/15 text-amber-300 text-[10px] font-medium"
                title={`${msg.switchedModel.reason || '回答被重写'}${msg.model ? `（你选的是 ${msg.model.provider}/${msg.model.id}）` : ''}`}>
                {msg.switchedModel.sameModel ? '已重写' : `兜底 ${msg.switchedModel.id}`}
              </span>
            )}
            {msg.model && <span className="px-1.5 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-dim2 text-[10px]" title={`${msg.model.provider}/${msg.model.id}`}>{msg.model.id}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
