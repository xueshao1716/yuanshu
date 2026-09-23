import { useEffect, useState } from 'react'
import { readPreference } from './useWidgetMotion'

async function getJson(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal, headers: { Authorization: 'Bearer ' + (readPreference('yuanshu_access_token') || '') } })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}
export function useWidgetStatus() {
  const [name, setName] = useState('小语')
  const [busy, setBusy] = useState<number | null>(null)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState('')
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    getJson('/api/persona', signal).then(j => { if (!signal.aborted && j?.definition?.name) setName(j.definition.name) }).catch(() => {})
    getJson('/api/frontend-version', signal).then(j => { if (!signal.aborted) setVersion(j?.appVersion || '') }).catch(() => {})
    const tick = async () => {
      try {
        const j = await getJson('/api/tasks', signal)
        const tasks = Array.isArray(j) ? j : j?.tasks || j?.items || j?.list
        if (!signal.aborted) setBusy(Array.isArray(tasks) ? tasks.filter(t => t?.running === true || ['running', 'in_progress', 'executing', 'working'].includes(String(t.status || t.state).toLowerCase())).length : null)
      } catch { if (!signal.aborted) setBusy(null) }
    }
    void tick()
    const timer = setInterval(tick, 15000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [])
  const checkUpdate = async () => {
    if (checking) return
    setChecking(true); setUpdate('正在检查…')
    try {
      const j = await getJson('/api/update/check', AbortSignal.timeout(15000))
      if (j?.upToDate === true) setUpdate('已是最新版本')
      else if (Number.isFinite(j?.behind) && j.behind > 0) setUpdate(`有可用更新（${j.behind} 个提交）`)
      else setUpdate('暂时无法确认更新，请稍后重试')
    } catch { setUpdate('检查失败，请稍后重试') }
    finally { setChecking(false) }
  }
  return { name, busy, version, update, checking, checkUpdate }
}
