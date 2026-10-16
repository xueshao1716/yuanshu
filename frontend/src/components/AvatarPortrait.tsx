import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

// 探测一次、全站共享：避免每条消息各发一个请求
let probePromise: Promise<string | null> | null = null

/** GET 探测形象图（服务端 isStatic 只放行 GET，勿用 HEAD）；加载成功返回 URL，失败返回 null */
export function probePortrait(): Promise<string | null> {
  if (!probePromise) {
    probePromise = new Promise(resolve => {
      const img = new Image()
      img.onload = () => resolve('/static/portraits/companion.png')
      img.onerror = () => resolve(null)
      img.src = '/static/portraits/companion.png'
    })
  }
  return probePromise
}

/**
 * 形象头像：探测 /static/portraits/companion.png（形象位定妆照）。
 * 有文件 → 显示真实形象；无文件 → 原样渲染 fallback（不占位、不破坏界面）。
 */
export default function AvatarPortrait({ fallback, className, imgClassName }: {
  fallback: ReactNode
  className?: string
  imgClassName?: string
}) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    probePortrait().then(s => { if (alive) setSrc(s) })
    return () => { alive = false }
  }, [])
  if (src) {
    return (
      <div className={`overflow-hidden flex-shrink-0 ${className || ''}`} style={{ boxShadow: 'var(--pi-shadow-sm)' }}>
        <img src={src} alt="小语" className={`w-full h-full object-cover ${imgClassName || ''}`} draggable={false} />
      </div>
    )
  }
  return <>{fallback}</>
}
