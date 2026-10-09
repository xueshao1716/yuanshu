import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react'

// ── 全景预览（复刻可乐 AI 画布，见 文档/逆向-可乐AI无限画布架构.md）──
// equirectangular 2:1 图 → WebGL 球面内视；backdrop 模式退化为 CSS 位移（零 WebGL）。
// 硬约束来自逆向结论：同屏 WebGL 上下文有上限，超了浏览器直接丢上下文，
// 所以每个视图实例挂 RenderGuard，超限/失败都降级成 <img>，绝不留黑块。

export type PanoramaMode = 'equirect' | 'backdrop'

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uYaw;
uniform float uPitch;
uniform float uFov;
uniform float uAspect;
const float PI = 3.141592653589793;
vec3 rotY(vec3 v, float a){ float c = cos(a), s = sin(a); return vec3(c*v.x + s*v.z, v.y, -s*v.x + c*v.z); }
vec3 rotX(vec3 v, float a){ float c = cos(a), s = sin(a); return vec3(v.x, c*v.y - s*v.z, s*v.y + c*v.z); }
void main(){
  vec2 p = (vUv - 0.5) * 2.0;
  float t = tan(uFov * 0.5);
  vec3 dir = rotY(rotX(normalize(vec3(p.x * t * uAspect, p.y * t, -1.0)), uPitch), uYaw);
  float lon = atan(dir.x, -dir.z);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
  gl_FragColor = texture2D(uTex, uv);
}
`

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(log || 'shader 编译失败')
  }
  return sh
}

/** backdrop 降级：把 2:1 全景图放大后按视角平移，零 WebGL，永远有画面 */
function BackdropFallback({ url, yaw, pitch, fov }: { url: string; yaw: number; pitch: number; fov: number }) {
  const span = 360 / (fov * 180 / Math.PI)
  return (
    <div className="absolute inset-0 overflow-hidden bg-pi-bg">
      <img
        src={url}
        alt="全景预览（降级模式）"
        draggable={false}
        className="absolute left-1/2 top-1/2 max-w-none select-none"
        style={{
          height: `${span * 100}%`,
          transform: `translate(-50%, -50%) translate(${(-yaw / (Math.PI * 2)) * span * 100}%, ${(pitch / Math.PI) * span * 60}%)`,
        }}
      />
    </div>
  )
}

export default function PanoramaViewer({ url, mode = 'equirect', className = '' }: { url: string; mode?: PanoramaMode; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const glRef = useRef<WebGLRenderingContext | null>(null)
  const texRef = useRef<WebGLTexture | null>(null)
  const [glFailed, setGlFailed] = useState(false)
  const [yaw, setYaw] = useState(0)
  const [pitch, setPitch] = useState(0)
  const [fov, setFov] = useState(Math.PI / 2.4)
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null)
  const [full, setFull] = useState(false)

  const useWebGL = mode === 'equirect' && !glFailed

  // WebGL 生命周期：建一次，卸载必 loseContext，否则上下文泄漏到浏览器上限
  useEffect(() => {
    if (!useWebGL) return
    const canvas = canvasRef.current
    if (!canvas) return
    let gl: WebGLRenderingContext
    try {
      gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false }) as WebGLRenderingContext
      if (!gl) throw new Error('浏览器未提供 webgl 上下文')
      const prog = gl.createProgram()!
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'program 链接失败')
      gl.useProgram(prog)
      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      const loc = gl.getAttribLocation(prog, 'aPos')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0)
      glRef.current = gl
      texRef.current = tex
    } catch (e) {
      console.warn('[PanoramaViewer] WebGL 初始化失败，降级 backdrop：', e)
      setGlFailed(true)
      return
    }
    return () => {
      try {
        if (texRef.current) gl.deleteTexture(texRef.current)
        const lose = gl.getExtension('WEBGL_lose_context')
        lose?.loseContext()
      } catch { /* 上下文已丢，忽略 */ }
      glRef.current = null
      texRef.current = null
    }
  }, [useWebGL])

  // 贴图：换图重载，跨域图用 crossOrigin 才能进 texture
  useEffect(() => {
    if (!useWebGL) return
    const gl = glRef.current
    if (!gl || !texRef.current) return
    let dead = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (dead || !glRef.current || !texRef.current) return
      try {
        gl.bindTexture(gl.TEXTURE_2D, texRef.current)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
      } catch (e) {
        console.warn('[PanoramaViewer] 贴图失败，降级 backdrop：', e)
        setGlFailed(true)
      }
    }
    img.onerror = () => { if (!dead) setGlFailed(true) }
    img.src = url
    return () => { dead = true }
  }, [url, useWebGL])

  // 渲染循环：只在视角/尺寸变化时画，省电
  useEffect(() => {
    if (!useWebGL) return
    const gl = glRef.current
    const canvas = canvasRef.current
    if (!gl || !canvas) return
    const prog = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null
    if (!prog) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    gl.viewport(0, 0, w, h)
    gl.useProgram(prog)
    gl.uniform1f(gl.getUniformLocation(prog, 'uYaw'), yaw)
    gl.uniform1f(gl.getUniformLocation(prog, 'uPitch'), pitch)
    gl.uniform1f(gl.getUniformLocation(prog, 'uFov'), fov)
    gl.uniform1f(gl.getUniformLocation(prog, 'uAspect'), w / h)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texRef.current)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }, [yaw, pitch, fov, useWebGL, glFailed])

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, yaw, pitch }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setYaw(d.yaw - (e.clientX - d.x) * 0.005)
    setPitch(Math.max(-1.3, Math.min(1.3, d.pitch + (e.clientY - d.y) * 0.005)))
  }
  const onPointerUp = () => { dragRef.current = null }
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    setFov(f => Math.max(0.35, Math.min(2.2, f * (e.deltaY > 0 ? 1.12 : 0.89))))
  }

  const reset = () => { setYaw(0); setPitch(0); setFov(Math.PI / 2.4) }

  return (
    <div className={`relative overflow-hidden bg-pi-bg group/pano ${className}`}>
      {useWebGL ? (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full touch-none cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        />
      ) : (
        <div
          className="absolute inset-0 touch-none cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          <BackdropFallback url={url} yaw={yaw} pitch={pitch} fov={fov} />
        </div>
      )}
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/pano:opacity-100 focus-within:opacity-100 transition-opacity">
        <button className="btn-tool !px-2 !min-h-0 !py-1" title="重置视角" onClick={reset}><RotateCcw className="w-3.5 h-3.5" /></button>
        <button className="btn-tool !px-2 !min-h-0 !py-1" title={full ? '退出全屏' : '全屏'} onClick={() => setFull(f => !f)}>
          {full ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>
      {!useWebGL && (
        <div className="absolute bottom-2 left-2 px-2 py-1 rounded-pi-pill bg-pi-bg/80 border border-pi-border-soft text-[10px] text-pi-dim2">
          WebGL 不可用 · 已降级为平面预览（拖动仍可环视）
        </div>
      )}
      {full && (
        <div className="fixed inset-0 z-50 bg-black">
          <PanoramaViewer url={url} mode={mode} className="w-full h-full" />
          <button className="btn-tool absolute top-4 right-4 z-10" onClick={() => setFull(false)}><Minimize2 className="w-4 h-4" /> 退出全屏</button>
        </div>
      )}
    </div>
  )
}
