import { useEffect, useState } from 'react'

type PortraitMeta = { title?: string; subtitle?: string; note?: string }

const BASE = '/static/portraits/companion'

/**
 * 通用伙伴形象位（2026-10-16 v2.127.13）：任何部署把图片放到 public/portraits/companion.png
 * （可选 companion.json 提供 title/subtitle/note 文案）即可在灵魂培养页展示形象；
 * 文件不存在则整块不渲染，不影响其他部署，也不写死任何具体形象。
 */
export default function PortraitSlot() {
  const [src, setSrc] = useState('')
  const [meta, setMeta] = useState<PortraitMeta | null>(null)
  useEffect(() => {
    let alive = true
    const bust = `?v=${encodeURIComponent(String(Date.now()))}`
    void (async () => {
      // 2026-10-16 修：服务端静态白名单只放行 GET（server.mjs isStatic 写死 req.method==="GET"），
      // HEAD 探测会 401 导致整块不渲染——改用 GET 探测（同 URL 后续 <img> 走浏览器缓存）
      const head = await fetch(`${BASE}.png${bust}`).catch(() => null)
      if (!alive) return
      if (!head?.ok) return
      setSrc(`${BASE}.png${bust}`)
      const res = await fetch(`${BASE}.json${bust}`).catch(() => null)
      if (alive && res?.ok) {
        try { setMeta(await res.json() as PortraitMeta) } catch { /* 说明文件损坏时只显示图 */ }
      }
    })()
    return () => { alive = false }
  }, [])
  if (!src) return null
  return <figure className="cultivation-portrait">
    <a href={src} target="_blank" rel="noopener noreferrer" aria-label={meta?.title || '伙伴形象，点击查看原图'}>
      <img src={src} alt={meta?.note || '伙伴自定义形象'} />
    </a>
    <figcaption>
      <strong>{meta?.title || '伙伴形象'}</strong>
      {meta?.subtitle && <span>{meta.subtitle}</span>}
    </figcaption>
  </figure>
}
