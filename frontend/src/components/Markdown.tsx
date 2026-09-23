import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useEffect, useRef } from 'react'
import { highlightCode, highlightAuto } from '../lib/highlight'
import GenUIBlock from './GenUI'
import SafeBlock from './SafeBlock'
import FileLink from './FileLink'

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

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body text-[15px] leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '')
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
                  <pre className="code-block bg-pi-bg1 border border-pi-border rounded-lg p-3 overflow-x-auto my-2">{pre}</pre>
                </SafeBlock>
              )
            }
            return <code className="markdown-inline-code rounded px-1.5 py-0.5 text-[13px]" {...props}>{children}</code>
          },
          a({ children, href }) { return <FileLink href={href}>{children}</FileLink> },
          table({ children }) { return <div className="overflow-x-auto my-2"><table className="w-full border-collapse">{children}</table></div> },
          th({ children }) { return <th className="border border-gray-700 px-3 py-1.5 bg-gray-800/50 font-semibold text-left">{children}</th> },
          td({ children }) { return <td className="border border-gray-700 px-3 py-1.5">{children}</td> },
        }}>{text}</ReactMarkdown>
    </div>
  )
}
