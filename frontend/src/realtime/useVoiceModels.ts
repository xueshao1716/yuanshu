import { useEffect, useState } from 'react'
import { requestVoiceModels, type VoiceModel } from './ticket'

export function useVoiceModels(open: boolean) {
  const [models, setModels] = useState<VoiceModel[]>([])
  const [modelKey, setModelKey] = useState('')
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!open) { setLoading(true); return }
    const controller = new AbortController()
    let live = true
    setLoading(true); setError('')
    const timeout = setTimeout(() => {
      if (live) { live = false; controller.abort(); setError('connection_failed'); setLoading(false) }
    }, 10000)
    requestVoiceModels(controller.signal).then(list => {
      if (!live) return
      setModels(list); setModelKey(current => current || list[0]?.modelKey || '')
    }).catch(e => { if (live) setError(e?.message || 'connection_failed') })
      .finally(() => { clearTimeout(timeout); if (live) setLoading(false) })
    return () => { live = false; clearTimeout(timeout); controller.abort() }
  }, [open, revision])
  const selectedModel = models.find(m => m.modelKey === modelKey)
  return { models, modelKey, setModelKey, loading, error, selectedModel, retry: () => setRevision(n => n + 1) }
}
