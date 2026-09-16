import { Brain, Wrench, CheckCircle } from 'lucide-react'

interface AgentWorkflowProps {
  phase: 'thinking' | 'tools' | 'result' | 'idle'
  thinking?: boolean
  toolsRunning?: number
  toolsTotal?: number
}

/**
 * Agent 工作流阶段式状态轨迹
 * 
 * 按 RuiRui 报告原则：有导演意识的阶段式揭示
 * - 思考（脉动）
 * - 调用工具（展开）
 * - 结果生成（收束）
 */
export function AgentWorkflow({ phase, thinking, toolsRunning = 0, toolsTotal = 0 }: AgentWorkflowProps) {
  return (
    <div className="flex items-center gap-3 py-3 px-4 border border-pi-border-soft bg-pi-bg1 rounded-pi-lg">
      {/* 阶段 1: 思考 */}
      <div className={`flex items-center gap-2 ${phase === 'thinking' ? 'opacity-100' : 'opacity-40'}`}>
        <div className={`w-6 h-6 rounded-full flex items-center justify-center ${phase === 'thinking' ? 'bg-pi-accent text-pi-on-accent' : 'bg-pi-bg2 text-pi-dim2'}`}>
          <Brain className={`w-3.5 h-3.5 ${phase === 'thinking' && thinking ? 'animate-pulse' : ''}`} />
        </div>
        <span className="text-xs text-pi-dim font-medium">思考</span>
      </div>

      {/* 连接线 */}
      <div className={`h-px flex-1 ${phase === 'tools' || phase === 'result' ? 'bg-pi-accent' : 'bg-pi-border-soft'}`} 
           style={{ maxWidth: '40px' }} />

      {/* 阶段 2: 工具调用 */}
      <div className={`flex items-center gap-2 ${phase === 'tools' ? 'opacity-100' : 'opacity-40'}`}>
        <div className={`w-6 h-6 rounded-full flex items-center justify-center ${phase === 'tools' ? 'bg-pi-accent text-pi-on-accent' : 'bg-pi-bg2 text-pi-dim2'}`}>
          <Wrench className={`w-3.5 h-3.5 ${phase === 'tools' ? 'animate-pulse' : ''}`} />
        </div>
        <span className="text-xs text-pi-dim font-medium">
          工具
          {phase === 'tools' && toolsTotal > 0 && (
            <span className="ml-1 text-pi-accent">{toolsRunning}/{toolsTotal}</span>
          )}
        </span>
      </div>

      {/* 连接线 */}
      <div className={`h-px flex-1 ${phase === 'result' ? 'bg-pi-accent' : 'bg-pi-border-soft'}`}
           style={{ maxWidth: '40px' }} />

      {/* 阶段 3: 结果生成 */}
      <div className={`flex items-center gap-2 ${phase === 'result' ? 'opacity-100' : 'opacity-40'}`}>
        <div className={`w-6 h-6 rounded-full flex items-center justify-center ${phase === 'result' ? 'bg-pi-success text-white' : 'bg-pi-bg2 text-pi-dim2'}`}>
          <CheckCircle className={`w-3.5 h-3.5`} />
        </div>
        <span className="text-xs text-pi-dim font-medium">生成</span>
      </div>
    </div>
  )
}
