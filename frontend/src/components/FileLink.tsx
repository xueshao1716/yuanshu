import { useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { Check, Copy, Globe2 } from 'lucide-react'
import { apiUrl, downloadApiFile, withFileToken } from '../api'
import { artifactName, fileNameFromUrl, artifactExtension } from '../lib/artifact-name'
import { copyText } from '../lib/clipboard'

/** 从扩展名反推产物类型，用于命名契约的「类型」段（docs/NAMING.md）。 */
function kindFromName(name: string): string {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
  const hit = Object.entries({ image: ['png', 'jpg', 'jpeg', 'webp', 'gif'], video: ['mp4', 'webm', 'mov'], audio: ['wav', 'mp3', 'm4a', 'ogg'], document: ['md', 'pdf', 'pptx', 'docx'], text: ['txt', 'json', 'csv'], html: ['html', 'htm'] })
    .find(([, exts]) => exts.includes(ext))
  return hit ? hit[0] : 'document'
}

/** Links in the answer and video attachment buttons share the same authenticated download path. */
export default function FileLink({ href, children }: { href?: string; children: ReactNode }) {
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const workspace = Boolean(href?.includes('/api/ws/file'))
  const save = workspace && /下载|保存|download/i.test(String(children))
  const resolvedHref = href ? apiUrl(href) : ''
  const url = href ? withFileToken(resolvedHref) : undefined
  const absoluteUrl = (() => {
    if (!resolvedHref) return ''
    try { return new URL(resolvedHref, window.location.href).href } catch { return resolvedHref }
  })()
  const canOpen = /^https?:\/\//i.test(absoluteUrl)
  const copyUrl = workspace ? (url || absoluteUrl) : absoluteUrl
  // 以前这里传 undefined，api.ts 兜底成字面量 “download”——下载下来连扩展名都没有，多个文件全叫 download。
  const downloadName = (link: string): string => {
    const real = fileNameFromUrl(link)
    if (real) return real
    const kind = kindFromName(link)
    return artifactName({ slug: String(children || ''), kind, ext: artifactExtension(kind) })
  }
  const announceTimer = useRef<number | undefined>(undefined)
  const announce = (text: string) => {
    setMessage(text)
    if (announceTimer.current) window.clearTimeout(announceTimer.current)
    announceTimer.current = window.setTimeout(() => setMessage(''), 1800)
  }
  const openInApp = () => {
    if (!absoluteUrl) return
    window.dispatchEvent(new CustomEvent('pi-open-browser', { detail: { url: absoluteUrl } }))
  }
  const handleLinkClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // 普通点击留在元枢里，避免 target=_blank 把用户送进一个没有返回入口的新标签页。
    // 按住修饰键时仍保留浏览器原生的新标签/新窗口行为。
    if (!save && canOpen && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
      event.preventDefault()
      openInApp()
    }
  }
  const copyLink = async () => announce(await copyText(copyUrl) ? '链接已复制' : '复制失败，请长按链接选择复制')
  return <span className="markdown-link-wrap"><span className="markdown-link-line"><a href={url} target="_blank" rel="noopener noreferrer" className="text-pi-accent hover:underline" aria-busy={saving || undefined} onClick={save ? async e => {
    e.preventDefault()
    if (saving || !href) return
    setSaving(true)
    try { setMessage(await downloadApiFile(href, downloadName(href), setMessage)) }
    catch (error: any) { setMessage(error?.message || '下载失败，请重试') }
    finally { setSaving(false) }
  } : handleLinkClick}>{children}</a>{canOpen && <span className="markdown-link-actions" role="group" aria-label="链接操作">
    <button type="button" className="markdown-link-action" onClick={openInApp} title="在元枢内置浏览器打开"><Globe2 className="h-3 w-3" />打开</button>
    <button type="button" className="markdown-link-action" onClick={copyLink} title="复制真实链接"><Copy className="h-3 w-3" />复制链接</button>
  </span>}</span>{message && <span role="status" className="block text-xs text-pi-dim leading-relaxed"><Check className="mr-1 inline h-3 w-3 text-pi-success" />{message}{save && !saving && <a className="ml-2 text-pi-accent underline" href={url} target="_blank" rel="noopener noreferrer">打开原文件保存</a>}</span>}</span>
}
