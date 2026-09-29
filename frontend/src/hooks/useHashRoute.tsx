import { useEffect, useRef, useState, Component, ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

// ── 极轻 hash 路由（零依赖）：#/chat #/models #/assets #/tasks ──
export type Route = 'chat' | 'board' | 'review' | 'models' | 'assets' | 'tasks' | 'downloads' | 'apps' | 'lingxi' | 'workshop' | 'story' | 'system' | 'engine' | 'themes' | 'sessiondb' | 'soul'

function parse(routes: readonly Route[]): Route {
  const h = location.hash.replace(/^#\/?/, '')
  return routes.includes(h as Route) ? h as Route : 'chat'
}

export function useHashRoute(routes: readonly Route[]): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parse(routes))
  const current = useRef(route)
  const accept = (next: Route) => {
    if (next === current.current) return true
    if (!window.dispatchEvent(new CustomEvent('yuanshu:before-route', {cancelable:true, detail:{from:current.current,to:next}}))) return false
    current.current=next; setRoute(next); return true
  }
  useEffect(() => {
    const on = () => {if (!accept(parse(routes))) history.replaceState(history.state, '', '#/' + current.current)}
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [routes])
  const nav = (r: Route) => {if (accept(r)) location.hash = '#/' + r}
  return [route, nav]
}

// ── 页面级 ErrorBoundary（路线图：每路由 lazy + ErrorBoundary）──
interface EBProps { children: ReactNode; page: string }
export class PageErrorBoundary extends Component<EBProps, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  render() {
    if (this.state.err) {
      const loadFailed = /Failed to fetch dynamically imported module|Loading chunk|ChunkLoadError|Importing a module script failed|error loading dynamically imported module/i.test(this.state.err.message)
      return (
        <div className="flex-1 flex items-center justify-center p-4 sm:p-8">
          <div className="panel p-6 max-w-md min-w-0 text-center" role="alert">
            <div className="text-pi-warning mb-2 flex justify-center"><AlertTriangle className="w-8 h-8" strokeWidth={1.6} aria-hidden="true" /></div>
            <div className="font-semibold text-pi-text mb-2">{this.props.page}{loadFailed ? ' 页面未加载完整' : ' 页面暂时无法显示'}</div>
            <p className="text-sm text-pi-dim leading-relaxed mb-4">{loadFailed ? '页面资源加载中断，可能与网络或系统更新有关。重新加载后可再次尝试打开。' : '请重试；如果仍未恢复，可以展开错误详情，帮助定位问题。'}</p>
            <button type="button" className="btn-primary min-h-11 text-sm px-4" onClick={() => loadFailed ? location.reload() : this.setState({ err: null })}>{loadFailed ? '重新加载页面' : '重试'}</button>
            <details className="mt-3 text-left"><summary className="min-h-11 flex items-center cursor-pointer text-xs text-pi-dim">错误详情</summary><p className="text-xs text-pi-dim break-all">{this.state.err.message}</p></details>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
