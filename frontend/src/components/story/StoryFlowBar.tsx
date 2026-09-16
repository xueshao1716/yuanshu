// 流水线状态条：把「现在该干什么 / 为什么这个按钮点不了」摊在界面上。
//
// 学自 Pavo 的做法：判断在服务端（engine/story-flow.mjs 的 storyFlow()），
// 前端只负责渲染 allowed / blocked / recommended——**不自己写一份规则**。
// 两份规则早晚会不一致，而用户看到的永远是错的那一份。
import type { StoryFlow } from '../../types'

// 动作 → 面板锚点：点了就把对应面板滚进视野，省得用户在十几个面板里找。
const PANEL_ANCHOR: Record<string, string> = {
  bible: 'story-panel-bible',
  script: 'story-panel-script',
  assets: 'story-panel-settings',
  shots: 'story-panel-beat',
  film: 'story-panel-film',
}

export default function StoryFlowBar({ flow, busy, onAction }: {
  flow?: StoryFlow
  busy?: boolean
  onAction: (action: string) => void
}) {
  if (!flow) return null
  const allowed = new Map(flow.allowed_actions.map(a => [a.action, a]))
  const recommended = flow.recommended_actions.map(id => allowed.get(id)).filter(Boolean)
  // 明细折进 title：它与胶囊/headline 说的是同一件事，单独占一行只会把状态条撑高
  // （真机量过 124px，其中一行就是它）。要看数字时悬停即可，不常驻。
  const detail = [
    `段落 ${flow.progress.beats.done}/${flow.progress.beats.total}`,
    flow.progress.beats.running ? `进行中 ${flow.progress.beats.running}` : '',
    flow.progress.beats.failed ? `失败 ${flow.progress.beats.failed}` : '',
    `定妆照 ${flow.progress.assets.portraits}/${flow.progress.assets.characters}`,
    flow.progress.assets.missingRefs ? `缺参考图 ${flow.progress.assets.missingRefs}` : '',
    `可用片段 ${flow.progress.clips.usable}`,
    flow.progress.external ? `外链产物 ${flow.progress.external}` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className="story-flow" aria-label="流水线状态" title={detail}>
      <div className="story-flow-steps">
        {flow.steps.map((step, i) => (
          <span key={step.id} className={`story-flow-step${step.id === flow.current_step ? ' is-current' : ''}${step.done ? ' is-done' : ''}`} title={step.hint}>
            <b>{step.done ? '✓' : i + 1}</b>{step.label}
            {i < flow.steps.length - 1 && <i className="story-flow-chevron">›</i>}
          </span>
        ))}
      </div>
      <div className="story-flow-body">
        <p className="story-flow-headline" title={`${flow.headline}｜${detail}`}>{flow.headline}</p>
      </div>
      <div className="story-flow-actions">
        {/* 主次分明：一个视口只留一个主按钮。其余推荐动作折进「其他动作」——
            三个同权重按钮并排时，眼睛没有落点（用户原话是"不好看"，量下来是 124px 的行里挤了 5 类信息）。 */}
        {recommended.length > 0 && (
          <button
            key={recommended[0].action}
            className="btn-primary"
            disabled={Boolean(busy)}
            onClick={() => onAction(recommended[0].action)}
            title={PANEL_ANCHOR[recommended[0].panel] ? `跳到「${recommended[0].label}」` : recommended[0].label}
          >{recommended[0].label}</button>
        )}
        {recommended.length > 1 && (
          <details className="story-flow-more">
            <summary>其他动作</summary>
            <div className="story-flow-more-list">
              {recommended.slice(1).map(item => (
                <button
                  key={item.action}
                  className="btn-ghost"
                  disabled={Boolean(busy)}
                  onClick={() => onAction(item.action)}
                  title={PANEL_ANCHOR[item.panel] ? `跳到「${item.label}」` : item.label}
                >{item.label}</button>
              ))}
            </div>
          </details>
        )}
      </div>
      {flow.blocked_actions.length > 0 && (
        <details className="story-flow-blocked">
          <summary>{flow.blocked_actions.length} 个动作现在做不了（点开看原因）</summary>
          <ul>
            {flow.blocked_actions.map(b => (
              <li key={b.action}><b>{b.label}</b>：{b.message}<code>{b.reason_code}</code></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

export { PANEL_ANCHOR }
