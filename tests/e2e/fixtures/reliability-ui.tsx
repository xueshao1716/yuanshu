import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import BrowserPanel from '../../../frontend/src/components/BrowserPanel'
import BackgroundRecoveryStatus from '../../../frontend/src/components/BackgroundRecoveryStatus'
import TeamDeliveryStatus from '../../../frontend/src/components/TeamDeliveryStatus'
import type { RunSummary } from '../../../frontend/src/api'
import { bootTheme } from '../../../frontend/src/theme/apply'
import 'virtual:uno.css'
import '../../../frontend/src/styles.css'

bootTheme()
const decisions = ['awaiting_acceptance', 'ready_to_publish', 'acceptance_stale', 'rejected', 'submission_failed', 'quality_failed', 'unverified']
function Fixture() {
  const [open, setOpen] = useState(false)
  const [decision, setDecision] = useState(decisions[0])
  const [updates, setUpdates] = useState(0)
  const run = { id: 'fixture-run', sessionId: 'fixture-session', status: 'queued',
    backgroundRecovery: { enabled: true, used: 1, maxResumes: 3, deadlineAt: new Date(Date.now() + 3600000).toISOString(), state: 'scheduled', reason: null },
    deliveries: [{ deliveryId: 'fixture-delivery', draft: '工程/天团交付/fixture/草稿.md',
      evidencePath: '工程/天团交付/fixture/核验记录.json', decision }],
  } as RunSummary
  return <main style={{ maxWidth: 760, margin: '0 auto', padding: 20 }}>
    <h1>元枢可靠性 · 隔离验收页面</h1>
    <p>以下为测试数据，不是正在执行的任务。</p>
    <button type="button" className="touch-hit" onClick={() => setOpen(true)}>打开测试浏览器</button>
    <BackgroundRecoveryStatus run={run} onUpdated={() => setUpdates(value => value + 1)} />
    <output aria-label="状态刷新次数">{updates}</output>
    <TeamDeliveryStatus run={run} />
    <label>验收测试状态<select aria-label="验收测试状态" value={decision} onChange={event => setDecision(event.target.value)}>
      {decisions.map(value => <option key={value} value={value}>{value}</option>)}
    </select></label>
    <BrowserPanel open={open} initialUrl={location.origin + '/fixture/one'} onClose={() => setOpen(false)} />
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
