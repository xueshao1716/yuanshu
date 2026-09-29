import { fail } from './voice-task-store.mjs'
const bounded = (value, max = 1600) => String(value || '').slice(0, max)
const plain = value => bounded(value).replace(/!?\[([^\]\n]*)\]\([^\n]*?\)/g, '$1').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const acceptanceLabels = { pending: '待验收', pass: '人工验收通过', fail: '人工验收未通过', stale: '验收已过期', revoke: '验收已撤销' }
export function readVoiceTaskResult(taskEvidence, run, task) {
  if (run.id !== task.runId || run.sessionId !== task.sessionId || run.clientRequestId !== task.id) throw fail('result_owner_mismatch')
  const evidence = taskEvidence.get(run.id)
  if (evidence.runId !== run.id || evidence.sessionId !== task.sessionId || evidence.status !== run.status) throw fail('result_owner_mismatch')
  const artifacts = (evidence.artifacts || []).filter(a => !a.error && a.digest && typeof a.path === 'string').slice(0, 20)
    .map(a => ({ path: a.path, size: a.size, digest: a.digest, url: '/api/ws/file?path=' + encodeURIComponent(a.path) }))
  const issues = (evidence.issues || []).map(value => bounded(value, 300)).slice(0, 20)
  if (run.status !== 'completed') issues.unshift(bounded(run.error || run.pauseMessage || run.pauseReason || task.reason || run.status, 300))
  const objective = evidence.objective?.status || 'UNVERIFIED'
  if (objective === 'FAIL') issues.push('产物结构检查未通过，请打开执行记录核对。')
  return { status: run.status, summary: plain(evidence.text) || '暂无可交付正文，请查看执行记录。',
    model: run.request?.model || run.input?.model || null, requirementRevision: task.requirementRevision || 1, resultVersion: 1,
    artifacts, acceptance: evidence.acceptance || 'pending', evidenceDigest: evidence.digest,
    verification: `结构检查：${objective}（不代表内容质量验收）；${acceptanceLabels[evidence.acceptance] || '待验收'}`,
    unfinished: [...new Set(issues)], detailUrl: '/api/runs/' + encodeURIComponent(run.id) }
}
export function voiceTaskResultText(task, result) {
  const labels = { completed: '执行完成', failed: '失败', stopped: '已停止', interrupted: '执行中断，未自动重跑', blocked: '未执行' }
  const sections = ['通话任务 · ' + plain(task.title) + ' · ' + (labels[result.status || task.status] || '任务结果'),
    '需求版本：' + (result.requirementRevision || task.requirementRevision || 1), plain(result.summary) || '暂无可交付正文']
  if (result.artifacts?.length) sections.push('实际产物：\n' + result.artifacts.map(a => `[${String(a.path).replace(/[\[\]\\\r\n]/g, '_')}](/api/ws/file?path=${encodeURIComponent(a.path)})`).join('\n'))
  sections.push('验证：' + (result.verification || '尚未核验，待验收'))
  sections.push('未完成项：' + (result.unfinished?.length ? result.unfinished.map(value => bounded(value, 300)).join('；') : '暂无已记录阻塞项；任务要求是否全部满足仍需验收。'))
  if (task.runId) sections.push('[执行详情（运行记录）](/api/runs/' + encodeURIComponent(task.runId) + ')')
  sections.push('任务记录：' + task.id)
  return sections.join('\n\n')
}
