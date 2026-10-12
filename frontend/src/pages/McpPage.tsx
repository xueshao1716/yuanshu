import PageHeader from '../components/PageHeader'
import McpPanel from '../components/McpPanel'

export default function McpPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="MCP"
        description="外部 MCP server 接入：桌面控制、文件、截图等工具直接注入智能体。"
      />
      <McpPanel />
    </div>
  )
}
