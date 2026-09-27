import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useApp } from '../../store'

const UPDATE_CHECK_KEY = 'yuanshu_update_check_at'
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000

export function useWidgetStatus() {
  const [name, setName] = useState('小语')
  const { token, authed } = useApp()
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState('')
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    setName('小语'); setVersion(''); setUpdate('')
    if (!authed) return
    const controller = new AbortController()
    const { signal } = controller
    api('/api/persona', { signal }).then(j => { if (!signal.aborted && j?.definition?.name) setName(j.definition.name) }).catch(() => {})
    api('/api/frontend-version', { signal }).then(j => { if (!signal.aborted) setVersion(j?.appVersion || '') }).catch(() => {})
    // 公仔常驻桌面：每 30 分钟自动检查一次，但不在每次渲染/切页时重复请求。
    // 结果仍允许用户手动“检查更新”立即刷新。
    let last = 0
    try { last = Number(localStorage.getItem(UPDATE_CHECK_KEY) || 0) } catch {}
    if (Date.now() - last >= UPDATE_CHECK_INTERVAL) {
      try { localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now())) } catch {}
      api('/api/system/check-update', { signal, timeoutMs: 20000 }).then(j => {
        if (signal.aborted) return
        if (j?.ok && j.upToDate) setUpdate('已是最新版本 · 自动检查')
        else if (j?.ok && j.checkable !== false && j.remote?.sha) setUpdate(`有可用更新（${j.remote.sha}）`)
        else setUpdate('暂时无法确认更新，可稍后手动重试')
      }).catch(() => { if (!signal.aborted) setUpdate('自动检查失败，可稍后手动重试') })
    }
    return () => controller.abort()
  }, [token, authed])
  const checkUpdate = async () => {
    if (checking) return
    setChecking(true); setUpdate('正在检查…')
    try {
      const j = await api('/api/system/check-update', { signal: AbortSignal.timeout(20000) })
      if (j?.ok && j.upToDate === true) setUpdate(`已是最新版本${j.source ? ` · ${j.source}` : ''}`)
      else if (j?.ok && j.checkable !== false && j.remote?.sha) setUpdate(`有可用更新（远端 ${j.remote.sha}）`)
      else setUpdate('暂时无法确认更新，请稍后重试')
    } catch { setUpdate('检查失败，请稍后重试') }
    finally { setChecking(false) }
  }
  return { name, version, update, checking, checkUpdate }
}
