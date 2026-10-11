import { useEffect, useRef, useState } from 'react'

// 响应式幻灯片帧：容器多宽，1280×720 的页面就缩到多宽。
// 2026-10-11 修手机端 PPT 过大——之前大预览 width:100% 却没做缩放变换，
// 手机上等效放大 3.5 倍只看到页面左上角；封面/缩略图则是固定 scale。
export default function ScaledSlide({ html, title, className = '', style }: {
  html: string
  title: string
  className?: string
  style?: React.CSSProperties
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / 1280)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={boxRef} className={`relative w-full aspect-[16/9] overflow-hidden ${className}`} style={style}>
      {scale > 0
        ? <iframe srcDoc={html} sandbox="" title={title} loading="lazy"
            style={{ width: 1280, height: 720, border: 0, transform: `scale(${scale})`, transformOrigin: 'top left', pointerEvents: 'none', display: 'block' }} />
        : null}
    </div>
  )
}
