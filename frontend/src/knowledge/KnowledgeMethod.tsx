import type { KnowledgeMethodData } from './api'

export default function KnowledgeMethod({ value }: { value?: { verified: boolean; scope: string; method?: KnowledgeMethodData } }) {
  const proof = value?.method
  if (!proof || !value?.verified) return null
  return <section className="space-y-2 border-t border-pi-border-soft pt-3 leading-6 [overflow-wrap:anywhere]" aria-label="方法检查范围">
    <h5 className="font-medium">当前产物的字段契约已通过</h5>
    <p>{value.scope}</p>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-pi-dim">产物</dt><dd>{proof.artifactPath}</dd>
      <dt className="text-pi-dim">检查器</dt><dd>{proof.checker}</dd>
      <dt className="text-pi-dim">产物版本</dt><dd>{proof.artifactHash.slice(0, 16)}</dd>
      <dt className="text-pi-dim">清单版本</dt><dd>{proof.manifestHash.slice(0, 16)}</dd>
      <dt className="text-pi-dim">验证环境</dt><dd>{proof.environment.platform} · Node {proof.environment.nodeMajor} · 工作区 {proof.environment.workspace.slice(0, 12)}</dd>
      <dt className="text-pi-dim">关联任务</dt><dd>{proof.environment.runId}</dd>
    </dl>
    <ul className="space-y-1">{proof.assertions.map((item, index) => <li key={index}><code>{item.pointer}</code> = <code>{JSON.stringify(item.equals)}</code></li>)}</ul>
    <p className="text-pi-dim">只证明以上产物版本满足所列字段，不替代任务或天团的人工验收。来源、产物或授权变化后，引用会重新核对。</p>
  </section>
}
