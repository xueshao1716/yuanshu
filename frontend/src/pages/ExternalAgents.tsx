// 协作 agent（2026-11-19）：从系统页独立成页（在「更多」里）——允许元枢把编码活派给本机 Claude Code / Codex 等。
import PageHeader from '../components/PageHeader'
import ExternalAgentsPanel from '../components/panels/ExternalAgentsPanel'

export default function ExternalAgents() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto page-enter">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <PageHeader
          title="协作 agent"
          description="允许元枢把编码活派给本机的 Claude Code 或 Codex（只在工作区里改，定时任务不能用）。会消耗它们各自的额度。"
        />
        <div className="panel !p-4">
          <ExternalAgentsPanel />
        </div>
      </div>
    </div>
  )
}
