export interface WorkItem { id: string; name: string; status: string; at: string }
export interface WorkChild { id: string; role: string; task: string; model: string; status: string; summary: string; error: string; evidence: string[]; confidence: number | null; at: string }
export interface WorkGroup<T> { count: number; items: T[] }
export interface WorkExplanationData {
  version: number; runId: string; sessionId: string; goal: string; updatedAt: string
  status: { code: string; label: string; detail: string }
  executor: { engine: string; model: string }; basis: string[]
  tools: WorkGroup<WorkItem>; subagents: WorkGroup<WorkChild>
  artifacts: WorkGroup<{ id: string; name: string; path: string; kind: string; at: string }>
  memory: { writes: number; summary: string }
  verification: WorkGroup<{ name: string; state: string; at: string }> & { state: 'passed' | 'failed' | 'reported' | 'not_observed' }
  notes: string[]; problem: string; nextStep: string; coverage: string
}

export const workState = (status: string) => ({ completed: '执行结束', failed: '失败', error: '失败', running: '进行中', started: '已开始', cancelled: '已取消', interrupted: '已中断', not_observed: '未收到结束记录', passed: '检查通过', reported: '仅有自报' }[status] || '状态未记录')
export const workRole = (role: string) => ({ analyst: '分析员', reviewer: '核查员', planner: '规划员', mother: '母体协调层', sovereign: '主角色' }[role] || role)
export const workTool = (name: string) => ({ bash: '运行命令', read: '读取文件', write: '写入文件', edit: '编辑文件', web_search: '检索资料', web_fetch: '读取网页', todo_write: '更新计划', delegate_task: '派研究员', delegate_fork: '派研究员（带前文）', list: '列目录', grep: '搜索代码', run_code: '执行程序' }[name] || name)
export function workTime(value: string) {
  const time = new Date(value)
  return Number.isFinite(time.getTime()) ? time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '时间未记录'
}
