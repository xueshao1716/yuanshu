import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { memo, useEffect, useRef, useState } from 'react'
import { Maximize2, X } from 'lucide-react'
import { highlightCode, highlightAuto } from '../../lib/highlight'
import GenUIBlock from '../GenUI'
import { withFileToken } from '../../api'
import { isImageShownByMedia } from '../../lib/media-embed'
import SafeBlock from './SafeBlock'
import FileLink from './FileLink'
import { Check, Copy } from 'lucide-react'

// 代码块容器，带复制按钮
function CodeBlockWithCopy({ content, lang, children }: { content: string; lang?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('复制失败:', err)
    }
  }

  return (
    <div className="relative group my-2">
      <div className="absolute right-2 top-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-pi-bg2 hover:bg-pi-bg3 border border-pi-border rounded text-pi-dim hover:text-pi-text transition-colors"
          aria-label={copied ? '已复制' : '复制代码'}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" />
              <span>已复制</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      {lang && (
        <div className="absolute left-3 top-2 text-[10px] text-pi-dim2 uppercase tracking-wider opacity-60">
          {lang}
        </div>
      )}
      <pre className="code-block bg-pi-bg1 border border-pi-border rounded-lg p-3 overflow-x-auto">{children}</pre>
    </div>
  )
}


// 降级纯文本块：自定义渲染失败时的统一兜底
function PlainFallback({ content, className }: { content: string; className?: string }) {
  return (
    <pre className="code-block bg-pi-bg1 border border-pi-border rounded-lg p-3 overflow-x-auto my-2">
      <code className={className}>{content}</code>
    </pre>
  )
}

const MAX_MERMAID_CHARS = 64 * 1024

export function shouldRenderMermaid(code: string): boolean {
  return code.length <= MAX_MERMAID_CHARS
}

// Mermaid 图表渲染（CDN 加载，失败回退纯文本）
function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    const render = async () => {
      if (!shouldRenderMermaid(code)) return
      try {
        // 动态加载（08-25 性能审计：静态 import 把 mermaid 整包打进主包）
        if (!(window as any).mermaid) {
          try { ;(window as any).mermaid = (await import('mermaid')).default } catch {}
          if (!(window as any).mermaid) {
            await new Promise((res) => {
              const s = document.createElement('script')
              s.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js'
              s.onload = res; s.onerror = res
              document.head.appendChild(s)
            })
          }
        }
        if ((window as any).mermaid && ref.current) {
          ;(window as any).mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
          const { svg } = await (window as any).mermaid.render('mmd-' + Math.random().toString(36).slice(2), code)
          if (!cancelled && ref.current) ref.current.innerHTML = svg
        }
      } catch {}
    }
    render()
    return () => { cancelled = true }
  }, [code])
  return <div ref={ref} className="my-2 overflow-x-auto" data-mermaid-code={code}></div>
}

// 表格：容器自适应 + 单元格 anywhere 换行（长串不再撑破聊天宽度）；
// 角磊"放大":""按钮弹全屏扩看（豆包式）：桌面居中大窗、手机全屏，横向滚动，Esc/点外关闭。
function TableBlock({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  // 预览方向：wide=横屏（全宽，横向滚动看宽表）；tall=竖屏（手机竖持宽度，接近真实手机阅读）。
  const [mode, setMode] = useState<'wide' | 'tall'>('wide')
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <div className="md-table-wrap my-2">
      <button type="button" className="md-table-zoom" aria-label="放大查看表格"
        onClick={e => { e.stopPropagation(); e.preventDefault(); setOpen(true) }}>
        <Maximize2 className="w-3.5 h-3.5" strokeWidth={1.8} />
      </button>
      <table className="md-table">{children}</table>
      {open && (
        <div className="md-table-modal-mask" onClick={e => { if (e.target === e.currentTarget) setOpen(false) }} role="presentation">
          <div className={`md-table-modal ${mode === 'tall' ? 'md-table-modal-tall' : ''}`} role="dialog" aria-modal="true" aria-label="表格放大视图" onClick={e => e.stopPropagation()}>
            <div className="md-table-modal-head">
              <span>表格 · 可{mode === 'wide' ? '横向滚动' : '竖屏阅读'}</span>
              <div className="flex items-center gap-1.5">
                <button type="button" className={`btn-tool !px-2 !py-1 ${mode === 'wide' ? 'text-pi-accent' : ''}`} aria-pressed={mode === 'wide'} onClick={() => setMode('wide')}>横屏</button>
                <button type="button" className={`btn-tool !px-2 !py-1 ${mode === 'tall' ? 'text-pi-accent' : ''}`} aria-pressed={mode === 'tall'} onClick={() => setMode('tall')}>竖屏</button>
                <button type="button" className="btn-tool !px-2 !py-1" onClick={() => setOpen(false)} aria-label="关闭放大表格">
                  <X className="w-4 h-4" strokeWidth={1.8} />
                </button>
              </div>
            </div>
            <div className="md-table-modal-body"><table className="md-table">{children}</table></div>
          </div>
        </div>
      )}
    </div>
  )
}

// 正文图片键盘可达（2026-11-13）：以前只有鼠标/触摸能点开全屏——外面那层 onClick 代理
// 只认 event.target 是 IMG，所以键盘触发时把 click 转给 img 自己，走的是同一条查看器/画廊路径。
// 容器用 button 而不是裸 tabIndex：Tab 能停、Enter/Space 原生语义、读屏把它念成按钮。
function MarkdownImage({ src, alt }: { src: string; alt?: string }) {
  const imgRef = useRef<HTMLImageElement>(null)
  const label = (alt || '').trim()
  const activate = () => { try { imgRef.current?.click() } catch { /* 代理没挂时点不开，也不该抛 */ } }
  return (
    <button
      type="button"
      role="button"
      tabIndex={0}
      aria-label={label ? `查看大图：${label}` : '查看大图'}
      data-markdown-image=""
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault()
          event.stopPropagation()
          activate()
        }
      }}
      className="my-1 inline-block max-w-full cursor-zoom-in rounded-pi-lg p-0 align-baseline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pi-accent"
      style={{ border: 0, background: 'transparent', lineHeight: 0 }}
    >
      <img ref={imgRef} src={src} alt={label} loading="lazy" className="max-w-full rounded-pi-lg border border-pi-border-soft" />
    </button>
  )
}

// shownImageKeys：本条消息的媒体块已经展示过的图片（按本地路径归一，见 lib/media-embed）。
// 正文里再遇到同一张图就只留一行指引——同一条消息里同一张图只画一次。
function Markdown({ text, shownImageKeys }: { text: string; shownImageKeys?: ReadonlySet<string> }) {
  return (
    <div className="markdown-body text-[15px] leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }: any) {
            // [\w-]：语言名带连字符（dsh-ui）。以前 \w+ 把它截成 dsh，GenUI 一直没渲染出来
            const match = /language-([\w-]+)/.exec(className || '')
            const isBlock = (children as any)?.includes?.('\n') || match
            const content = String(children).replace(/\n$/, '')
            if (match?.[1] === 'mermaid') {
              return (
                <SafeBlock resetKey={content} fallback={<PlainFallback content={content} />}>
                  <MermaidBlock code={content} />
                </SafeBlock>
              )
            }
            if (match?.[1] === 'dsh-ui') {
              return (
                <SafeBlock resetKey={content} fallback={<PlainFallback content={content} />}>
                  <GenUIBlock raw={content} />
                </SafeBlock>
              )
            }
            if (isBlock) {
              const html = highlightCode(content, match?.[1]) ?? highlightAuto(content)
              const pre = html
                ? <code className={className} dangerouslySetInnerHTML={{ __html: html }} />
                : <code className={className}>{children}</code>
              return (
                <SafeBlock resetKey={content.slice(0, 64)} fallback={<PlainFallback content={content} className={className} />}>
                  <CodeBlockWithCopy content={content} lang={match?.[1]}>{pre}</CodeBlockWithCopy>
                </SafeBlock>
              )
            }
            return <code className="markdown-inline-code rounded px-1.5 py-0.5 text-[13px]" {...props}>{children}</code>
          },
          // dsh-ui 是卡片不是代码：去掉外层 <pre>，否则整张卡被套上代码块底色和等宽字
          pre({ children, node, ...props }: any) {
            const cls = node?.children?.[0]?.properties?.className
            if ((Array.isArray(cls) ? cls : [cls]).includes('language-dsh-ui')) return <>{children}</>
            return <pre {...props}>{children}</pre>
          },
          a({ children, href }) { return <FileLink href={href}>{children}</FileLink> },
          img({ src, alt }) {
            if (!src) return null
            // 远端外链图不再交给 /api/proxy/image：代理仍然依赖厂商地址活着，厂商一关就裂图。
            // 正文外链图应由后端归档器换成 /api/ws/file；这里兜底只给一行文字链接，
            // 本地/同源地址（/api/ws/file、data:、相对路径）照旧显示。
            const isRemote = /^(?:https?:)?\/\//i.test(src) && !/\/api\/ws\/file(?:[?#]|$)/i.test(src)
            if (isRemote) {
              return (
                <span className="inline-flex flex-wrap items-baseline gap-1 my-1 text-[13px] text-pi-dim">
                  （外链图未归档）
                  <a href={src} target="_blank" rel="noopener noreferrer" className="text-pi-accent hover:underline break-all">
                    原链接
                  </a>
                </span>
              )
            }
            // 同一张图媒体块已经画过（大图缩略 + 可点开全屏）：正文不再重复画一遍，
            // 只留一行指引（assistant 的媒体块就在正文下面）。
            if (isImageShownByMedia(src, shownImageKeys)) {
              return (
                <span className="inline-flex items-baseline gap-1 my-1 text-[12px] text-pi-dim2" data-image-dedupe="media"
                  title="这张图已由下方媒体块展示">
                  〔图片见下〕
                </span>
              )
            }
            const finalSrc = /^\/api\//i.test(src) ? withFileToken(src) : src
            return <MarkdownImage src={finalSrc} alt={alt || ''} />
          },
          table({ children }) { return <TableBlock>{children}</TableBlock> },
          th({ children }) { return <th className="border border-gray-700 px-3 py-1.5 bg-gray-800/50 font-semibold text-left">{children}</th> },
          td({ children }) { return <td className="border border-gray-700 px-3 py-1.5">{children}</td> },
        }}>{text}</ReactMarkdown>
    </div>
  )
}

export default memo(Markdown)
