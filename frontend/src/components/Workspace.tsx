import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUp, File, Folder, Paperclip, RefreshCw, Search, Upload } from 'lucide-react'
import { useApp } from '../store'
import { WsApi } from '../api'
const Markdown = lazy(() => import('./chat/Markdown'))

function LazyMarkdown({ text }: { text: string }) {
  return <Suspense fallback={<div className="text-pi-dim2 text-xs py-2">渲染中…</div>}><Markdown text={text} /></Suspense>
}

interface TreeNode { name: string; type: string; path: string }

export default function Workspace() {
  const { currentSessionId } = useApp()
  const [cur, setCur] = useState('')
  const [nodes, setNodes] = useState<TreeNode[]>([])
  const [selectedFile, setSelectedFile] = useState<{ name: string; path: string; content: string } | null>(null)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [tip, setTip] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const previewBackRef = useRef<HTMLButtonElement>(null)
  const requestRef = useRef({ tree: 0, file: 0 })
  const tipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flash = (msg: string) => { clearTimeout(tipTimer.current); setTip(msg); tipTimer.current = setTimeout(() => setTip(''), 4000) }

  // 交付：复制到 交付/ 目录（版本化）
  const deliver = async () => {
    if (!selectedFile || busy) return
    setBusy(true); setError('')
    try { const d = await WsApi.deliver(selectedFile.path, selectedFile.name); flash(`已交付到 ${d.path}`) }
    catch (e: any) { setError(`交付失败：${e.message}`) }
    finally { setBusy(false) }
  }
  // 上传：base64 → /api/files/upload
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    setBusy(true); setError('')
    try {
      const buf = await f.arrayBuffer()
      let bin = ''; const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      const d = await WsApi.upload(f.name, btoa(bin), currentSessionId || undefined)
      flash(`已上传 ${f.name}${d.path ? ' → ' + d.path : ''}`)
      loadTree(cur)
    } catch (e: any) { setError(`上传失败：${e.message}`) }
    finally { setBusy(false) }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const loadTree = useCallback(async (p = '') => {
    const id = ++requestRef.current.tree
    requestRef.current.file++
    setReading(false)
    setLoading(true); setError('')
    try {
      const d = await WsApi.tree(p)
      if (id === requestRef.current.tree) { setNodes(d.items || []); setCur(d.current || '') }
    } catch (e: any) { if (id === requestRef.current.tree) setError(`目录读取失败：${e.message}。可点击刷新重试。`) }
    finally { if (id === requestRef.current.tree) setLoading(false) }
  }, [])
  useEffect(() => {
    void loadTree('')
    return () => { requestRef.current.tree++; requestRef.current.file++; clearTimeout(tipTimer.current) }
  }, [loadTree])
  const openFile = async (path: string) => {
    const id = ++requestRef.current.file
    setReading(true); setError('')
    try { const d = await WsApi.read(path); if (id === requestRef.current.file) setSelectedFile(d) }
    catch (e: any) { if (id === requestRef.current.file) setError(`文件读取失败：${e.message}。请重试。`) }
    finally { if (id === requestRef.current.file) setReading(false) }
  }
  useEffect(() => {
    let alive = true
    setResults([])
    if (q.trim().length < 2) { setSearching(false); return }
    setSearching(true)
    const timer = setTimeout(() => {
      WsApi.search(q.trim()).then(d => { if (alive) setResults(d.results || []) })
        .catch((e: any) => { if (alive) setError(`搜索失败：${e.message}。请重试。`) })
        .finally(() => { if (alive) setSearching(false) })
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [q])
  useEffect(() => { if (selectedFile) previewBackRef.current?.focus() }, [selectedFile])

  const parentPath = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(0, -1).join('/')

  return (
    <div className="workspace-panel flex-1 flex flex-col min-h-0 min-w-0">
      {tip && <div role="status" className="px-3 py-2 text-xs text-pi-text border-b border-pi-border-soft">{tip}</div>}
      {error && <div role="alert" className="px-3 py-2 text-xs text-pi-danger border-b border-pi-border-soft break-words">{error}</div>}
      {selectedFile ? (
        <section className="workspace-preview flex-1 flex flex-col min-h-0 min-w-0" aria-label="文件预览">
          <div className="workspace-toolbar">
            <button ref={previewBackRef} type="button" className="btn-tool !h-9 !w-9 !p-0" aria-label="返回文件列表" title="返回文件列表" onClick={() => { setSelectedFile(null); requestAnimationFrame(() => searchRef.current?.focus()) }}><ArrowLeft className="w-4 h-4" /></button>
            <div className="min-w-0 flex-1"><h3 className="text-[13px] font-semibold truncate">{selectedFile.name}</h3><p className="text-[11px] text-pi-dim2 truncate" title={selectedFile.path}>{selectedFile.path}</p></div>
            <button type="button" className="btn-tool" disabled={busy} onClick={deliver} title="复制到交付目录（版本化）"><Paperclip className="w-3.5 h-3.5" />{busy ? '处理中' : '交付'}</button>
          </div>
          <div className="workspace-preview-content flex-1 min-h-0 overflow-auto p-4">
            {/\.(md|txt)$/i.test(selectedFile.name) ? <LazyMarkdown text={selectedFile.content} /> : <pre className="whitespace-pre-wrap text-[13px] text-pi-text font-mono">{selectedFile.content}</pre>}
          </div>
        </section>
      ) : (
      <section className="workspace-browser flex-1 flex flex-col min-h-0 min-w-0" aria-label="工作区文件">
        <div className="workspace-toolbar">
          <Folder className="w-4 h-4 text-pi-dim flex-shrink-0" strokeWidth={1.8} />
          <div className="text-xs text-pi-dim truncate flex-1" title={cur || '项目根目录'}>{cur || '项目根目录'}</div>
          {cur && <button type="button" className="btn-tool !h-8 !w-8 !p-0" title="返回上一级" aria-label="返回上一级" onClick={() => loadTree(parentPath(cur))}><ArrowUp className="w-3.5 h-3.5" /></button>}
          <button type="button" className="btn-tool !h-8 !w-8 !p-0" disabled={loading} title="刷新工作区" aria-label="刷新工作区" onClick={() => loadTree(cur)}><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
          <input ref={fileInputRef} type="file" className="hidden" onChange={onUpload} />
          <button type="button" className="btn-tool !h-8 !w-8 !p-0" disabled={busy} title="上传文件到工作区" aria-label="上传文件到工作区" onClick={() => fileInputRef.current?.click()}>
            <Upload className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="workspace-search"><Search className="w-3.5 h-3.5" /><input ref={searchRef} className="input-pi text-xs" aria-label="搜索工作区文件" placeholder="搜索文件…" value={q} onChange={e => { setError(''); setQ(e.target.value) }} /></div>
        {(loading || reading || searching) && <p role="status" className="px-4 py-2 text-xs text-pi-dim2">{searching ? '正在搜索…' : '正在加载…'}</p>}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {q.trim().length >= 2 ? (
            results.length ? results.map((r: any, i) => (
              <button type="button" key={i} className="workspace-file-row" onClick={() => openFile(r.path)}>
                <File className="w-4 h-4 text-pi-dim2 shrink-0" /><span className="min-w-0"><span className="block truncate text-pi-text">{r.name}</span><span className="block text-[11px] text-pi-dim2 truncate">{r.path}</span></span>
              </button>
            )) : !searching && !error && <p className="px-2 py-6 text-center text-xs text-pi-dim2">没有匹配的文件</p>
          ) : nodes.length ? nodes.map(n => (
            <button type="button" key={n.path} className="workspace-file-row" onClick={() => n.type === 'dir' ? loadTree(n.path) : openFile(n.path)}>
              {n.type === 'dir' ? <Folder className="w-4 h-4 text-pi-dim flex-shrink-0" strokeWidth={1.8} /> : <File className="w-4 h-4 text-pi-dim2 flex-shrink-0" strokeWidth={1.8} />}<span className="truncate">{n.name}</span>
            </button>
          )) : !loading && !error && <div className="px-2 py-6 text-center text-xs text-pi-dim2">当前目录为空</div>}
        </div>
      </section>
      )}
    </div>
  )
}
