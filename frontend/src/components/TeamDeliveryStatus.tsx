import { useState } from 'react'
import { downloadApiFile, type RunSummary } from '../api'

const labels: Record<string, string> = {
  awaiting_acceptance: '草稿已入队，等待你验收',
  ready_to_publish: '已人工验收，当前文件与验收记录一致',
  acceptance_stale: '验收后的文件已变化，需重新核对',
  rejected: '本次草稿已拒绝，需修改后重新提交',
  submission_failed: '草稿已保存，但提交验收失败，请检查待审存储',
  quality_failed: '文本流程检查未通过，不能交付',
  unverified: '文件或核验记录缺失、发生变化，暂不能确认验收状态',
}

export default function TeamDeliveryStatus({ run }: { run: RunSummary }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const download = async (path: string) => {
    if (busy) return
    setBusy(true); setFailed(false); setMessage('正在获取文件…')
    try { setMessage(await downloadApiFile(`/api/ws/file?path=${encodeURIComponent(path)}`, path.split('/').pop(), setMessage)) }
    catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : '下载失败，请稍后重试。') }
    finally { setBusy(false) }
  }
  if (run.deliveriesUnavailable) return <p role="status" className="mt-2 text-sm text-pi-dim">验收状态暂时读不到，请稍后刷新或打开工作台核对。</p>
  if (!run.deliveries?.length) return null
  return <div className="mt-3 min-w-0 space-y-3 text-sm" aria-label="天团交付验收">
    {run.deliveries.map(delivery => <div key={delivery.deliveryId} className="min-w-0">
      <p className="text-pi-text">{labels[delivery.decision] || '验收状态待核对'}</p>
      <p className="mt-1 text-pi-dim">仅文本流程及有界程序检查；模型复核不代替人工验收，也不代表图片或视频实测。</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <a className="inline-flex min-h-11 items-center text-pi-accent underline underline-offset-4" href="#/review">打开改动验收</a>
        <button type="button" disabled={busy} className="inline-flex min-h-11 items-center text-pi-accent underline underline-offset-4" onClick={() => void download(delivery.draft)}>下载草稿</button>
        <button type="button" disabled={busy} className="inline-flex min-h-11 items-center text-pi-accent underline underline-offset-4" onClick={() => void download(delivery.evidencePath)}>下载核验记录</button>
      </div>
    </div>)}
    {message && (failed ? <p role="alert" className="text-pi-danger">{message}</p> : <p role="status" className="text-pi-dim">{message}</p>)}
  </div>
}
