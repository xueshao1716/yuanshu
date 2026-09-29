/** @returns {{ proposals: Array<any>, notice: string, revision: number }} */
export const emptyTaskState = () => ({ proposals: [], notice: '', revision: 0 })
export function reduceTaskState(state, event) {
  if (event.type === 'task.proposal') {
    if (state.proposals.some(p => p.id === event.id)) return state
    return { ...state, notice: '', proposals: [...state.proposals, { ...event, status: 'pending' }].slice(-32) }
  }
  if (event.type === 'task.disconnected') return { ...state, proposals: state.proposals.map(p =>
    ['pending','submitting'].includes(p.status) ? { ...p, status: p.status === 'submitting' ? 'uncertain' : 'closed' } : p), revision: state.revision + 1 }
  const statuses = { 'task.submitting':'submitting', 'task.receipt':'accepted', 'task.resolved':'declined', 'task.expired':'expired', 'task.error':'uncertain' }
  const status = statuses[event.type]
  if (!status) return state
  const notice = event.type === 'task.error' ? event.code === 'submission_unconfirmed'
    ? '尚未收到受理回执，请刷新任务核对，勿重复提交。' : '未能生成任务确认，请检查内容后重试。'
    : event.type === 'task.receipt' ? '已受理，挂断后任务继续，结果会回到当前聊天。' : ''
  return { ...state, notice, revision: state.revision + 1,
    proposals: state.proposals.map(p => p.id === (event.proposalId || event.id) ? { ...p, status } : p) }
}
export function taskStatusText(task) {
  const names = { queued:'排队中', running:'执行中', stopping:'正在停止', waiting:'等待处理', completed:'执行结束', failed:'执行失败', stopped:'已停止', interrupted:'执行中断', blocked:'暂不能执行' }
  const name = names[task.status] || '等待状态更新'
  return name + (task.delivery?.status === 'delivered' ? ' · 结果已回到聊天' : task.delivery?.status === 'pending' ? ' · 等待回写聊天' : task.delivery?.status === 'blocked' ? ' · 结果回写受阻' : '')
}
export const canStopTask = task => !['completed','failed','stopped','interrupted','blocked'].includes(task.status)

function keepActionableAndRecent(items, actionable, historyLimit) {
  const recent = new Set(items.filter(item => !actionable(item)).slice(-historyLimit).map(item => item.id))
  return items.filter(item => actionable(item) || recent.has(item.id))
}
export const visibleProposals = proposals => keepActionableAndRecent(proposals, p => ['pending','submitting','uncertain'].includes(p.status), 6)
export const visibleTasks = tasks => keepActionableAndRecent(tasks, canStopTask, 20).reverse()
