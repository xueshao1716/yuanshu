import { useEffect, useRef, useState } from 'react'
import { isExternalVideo, isHlsUrl, tvMediaUrl } from '../lib/tv'
import { withFileToken } from '../api'

type Props = {
  src: string
  poster?: string
  title?: string
  autoPlay?: boolean
  startAt?: number
  className?: string
  onProgress?: (seconds: number, duration: number) => void
  onEnded?: () => void
}

// 外链走 /api/tv/media 同源代理；m3u8 优先用 hls.js（Chrome/Edge/Android WebView/新 iOS），
// 仅在没有 MSE 的老 iOS 内核回退原生播放（新版 Chrome 的原生 HLS 对代理地址不稳）。mp4 与工作空间文件直接用 <video>。
export default function VideoPlayer({ src, poster, title, autoPlay, startAt, className, onProgress, onEnded }: Props) {
  const ref = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const lastReport = useRef(0)

  useEffect(() => {
    const video = ref.current
    if (!video || !src) return
    setError('')
    const external = isExternalVideo(src)
    const url = external ? tvMediaUrl(src) : withFileToken(src)
    let hls: { destroy(): void } | null = null
    let disposed = false
    const seek = () => { if (startAt && startAt > 3 && video.currentTime < 1) { try { video.currentTime = startAt } catch {} } }
    video.addEventListener('loadedmetadata', seek, { once: true })
    const start = () => { if (autoPlay) video.play().catch(() => {}) }
    if (isHlsUrl(src)) {
      import('hls.js').then(({ default: Hls }) => {
        if (disposed) return
        if (!Hls.isSupported()) {
          if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; start() } else setError('当前设备不支持 HLS 播放')
          return
        }
        const instance = new Hls({ maxBufferLength: 30, enableWorker: true })
        hls = instance
        instance.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) setError('视频源连接失败，换一个线路试试')
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) instance.recoverMediaError()
          else setError('这个视频无法播放，换一个线路试试')
        })
        instance.loadSource(url)
        instance.attachMedia(video)
        instance.on(Hls.Events.MANIFEST_PARSED, start)
      }).catch(() => setError('播放组件加载失败'))
    } else {
      video.src = url
      start()
    }
    return () => {
      disposed = true
      video.removeEventListener('loadedmetadata', seek)
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
  }, [src, autoPlay, startAt])

  return (
    <div className={className}>
      <video
        ref={ref}
        controls
        playsInline
        preload="metadata"
        poster={poster}
        title={title}
        className="w-full aspect-video rounded-pi-lg border border-pi-border-soft bg-black"
        onError={() => { if (!isHlsUrl(src)) setError('视频暂时无法播放') }}
        onEnded={onEnded}
        onTimeUpdate={e => {
          if (!onProgress) return
          const now = Date.now()
          if (now - lastReport.current < 5000) return
          lastReport.current = now
          onProgress(e.currentTarget.currentTime, e.currentTarget.duration || 0)
        }}
      />
      {error && <p role="alert" className="mt-1.5 text-xs text-pi-danger">{error}</p>}
    </div>
  )
}
