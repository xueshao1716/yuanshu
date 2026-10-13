import { useEffect, useState } from 'react'
import { CheckCircle2, Download, FileDown, FolderOpen, RotateCcw, Trash2 } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'
import { downloadApiFile } from '../api'
import { clearDownloadHistory, readDownloadHistory, removeDownload, type DownloadRecord } from '../lib/downloads'
import { isDesktopShellEnvironment, openDownloadFolder } from '../lib/download-location'
import { canOpenNativeDownload, openNativeDownload } from '../lib/native-download'
import { PRODUCT_VERSION } from '../lib/artifact-name'

const formatSize = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size} B`
const formatTime = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function Downloads({ embedded = false }: { embedded?: boolean } = {}) {
  const [records, setRecords] = useState<DownloadRecord[]>(() => readDownloadHistory())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    const sync = () => setRecords(readDownloadHistory())
    window.addEventListener('yuanshu-download-recorded', sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener('yuanshu-download-recorded', sync); window.removeEventListener('storage', sync) }
  }, [])

  const retry = async (record: DownloadRecord) => {
    setBusyId(record.id)
    setActionError('')
    try { await downloadApiFile(record.url, record.name) }
    catch (error) { setActionError(`下载失败：${error instanceof Error ? error.message : '请稍后重试'}`) }
    finally { setBusyId(null); setRecords(readDownloadHistory()) }
  }

  const remove = (id: string) => { removeDownload(id); setRecords(readDownloadHistory()) }
  const clear = () => { clearDownloadHistory(); setRecords([]) }
  const revealFolder = async () => {
    if (folderBusy) return
    setFolderBusy(true)
    setActionError('')
    try {
      if (!await openDownloadFolder()) setActionError('当前设备不支持打开系统下载目录，请在文件管理器中查看。')
    } catch { setActionError(`无法打开系统下载目录。请确认客户端已更新到 ${PRODUCT_VERSION}，或在文件管理器中查看下载文件夹。`) }
    finally { setFolderBusy(false) }
  }

  const headerActions = (
    <div className="flex items-center gap-2">
      {isDesktopShellEnvironment() && <button type="button" className="btn-ghost text-xs px-3 min-h-10 inline-flex items-center gap-1.5" onClick={revealFolder} disabled={folderBusy}>
        <FolderOpen className="w-3.5 h-3.5" />{folderBusy ? '正在打开…' : '打开系统下载目录'}
      </button>}
      {records.length > 0 && <button type="button" className="btn-ghost text-xs px-3 min-h-10 inline-flex items-center gap-1.5" onClick={clear}><Trash2 className="w-3.5 h-3.5" />清空记录</button>}
    </div>
  )

  return (
    <div className={embedded ? "" : "flex-1 overflow-y-auto relative z-10"}>
      <div className={embedded ? "downloads-page" : "downloads-page max-w-3xl mx-auto px-4 sm:px-6 py-5 sm:py-6"}>
        {embedded
          ? <div className="flex flex-wrap items-center justify-between gap-2 mb-4"><span className="text-sm text-pi-dim">查看最近下载、保存位置，或重新获取文件 · {records.length} 条记录</span>{headerActions}</div>
          : <PageHeader title="下载中心" description="查看最近下载、保存位置，或重新获取文件。" meta={<span>{records.length} 条记录</span>} actions={headerActions} />}
        {actionError && <p role="alert" className="text-sm text-pi-danger mb-4 break-words">{actionError}</p>}
        {!records.length ? <EmptyState icon={FileDown} title="还没有下载记录" hint="在资产库、会话导出或交付物中点击下载，记录会自动出现在这里。" className="py-20" /> : (
          <section className="downloads-list" aria-label="最近下载">
            <div className="downloads-note"><Download className="w-4 h-4" /><span>{canOpenNativeDownload() ? '手机保存时可选择位置；已保存的文件可直接打开。' : '文件通常保存在系统下载目录；若更改过浏览器保存设置，请到所选目录查看。'}</span></div>
            <div className="space-y-2.5">
              {records.map(record => (
                <article key={record.id} className="download-record panel !p-3.5">
                  <div className="download-record__icon">{record.savedUri ? <CheckCircle2 className="w-4 h-4" /> : <Download className="w-4 h-4" />}</div>
                  <div className="download-record__content">
                    <strong title={record.name}>{record.name}</strong>
                    <span>{record.status === 'failed' ? '下载失败' : (record.savedUri || record.status === 'saved') ? '已保存' : '已发起下载'} · {formatSize(record.size)} · {formatTime(record.createdAt)}</span>
                    {record.location && <span>{record.location}</span>}
                  </div>
                  <div className="download-record__actions">
                    {record.savedUri && canOpenNativeDownload() && <button type="button" className="btn-tool" aria-label={`打开 ${record.name}`} title="打开文件" onClick={() => {
                      setActionError('')
                      try { openNativeDownload(record.savedUri!) } catch (error) { setActionError(error instanceof Error ? error.message : '无法打开文件') }
                    }}><FolderOpen className="w-4 h-4" /></button>}
                    <button type="button" className="btn-tool" aria-label={`重新下载 ${record.name}`} title="重新下载" disabled={busyId === record.id} onClick={() => retry(record)}><RotateCcw className={`w-4 h-4 ${busyId === record.id ? 'animate-spin' : ''}`} /></button>
                    <button type="button" className="btn-tool" aria-label={`移除 ${record.name}`} title="移除记录" onClick={() => remove(record.id)}><Trash2 className="w-4 h-4" /></button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
