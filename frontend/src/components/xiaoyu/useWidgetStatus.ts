import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useApp } from '../../store'
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
    return () => controller.abort()
  }, [token, authed])
  const checkUpdate = async () => {
    if (checking) return
    setChecking(true); setUpdate('正在检查…')
    try {
      const j = await api('/api/update/check', { signal: AbortSignal.timeout(15000) })
      if (j?.upToDate === true) setUpdate('已是最新版本')
      else if (Number.isFinite(j?.behind) && j.behind > 0) setUpdate(`有可用更新（${j.behind} 个提交）`)
      else setUpdate('暂时无法确认更新，请稍后重试')
    } catch { setUpdate('检查失败，请稍后重试') }
    finally { setChecking(false) }
  }
  return { name, version, update, checking, checkUpdate }
}
