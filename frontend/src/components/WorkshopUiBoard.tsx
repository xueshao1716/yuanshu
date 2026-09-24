import {lazy, Suspense} from 'react'
const WebsiteBoard = lazy(() => import('./website/WebsiteBoard'))
export default function WorkshopUiBoard() {
  return <Suspense fallback={<p role="status" className="text-pi-dim py-8">正在打开网站工坊…</p>}><WebsiteBoard /></Suspense>
}
