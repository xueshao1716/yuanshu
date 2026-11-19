// ══════════════════════════════════════════════════════════
// WebglBackdrop —— 主题驱动的 WebGL1 光场背景（方案A / threeui 借鉴）
// · 零依赖 raw WebGL：一个全屏 fragment shader 画两团柔和弥散光斑 + 暗角
// · 颜色从当前主题读 --pi-bg / --pi-accent / --pi-accent2（getComputedStyle），
//   主题一变（ThemeSwitcher 派生 / 预设切换）经 MutationObserver 自动刷新
// · 克制：uDim 控制强度；prefers-reduced-motion → 静态单帧；WebGL 不可用 → return null（CSS 渐变回退）
// ══════════════════════════════════════════════════════════
import { useEffect, useRef } from 'react'
import { lessMotion } from '../lib/lite-mode.mjs'

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`
const FRAG = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uBg;
uniform vec3 uAccent;
uniform vec3 uAccent2;
uniform float uDim;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}
void main(){
  vec2 uv=(gl_FragCoord.xy/uRes)-.5;
  uv.x*=uRes.x/uRes.y;
  float t=uTime*.035;
  vec2 p=uv*1.35+vec2(n(uv*2.0+t),n(uv*2.0-t))*.16;
  vec2 c1=vec2(.38,.26); vec2 c2=vec2(-.42,-.32);
  c1+=vec2(n(p+t*1.3)*.24-.12, n(p-t*1.3)*.24-.12);
  c2+=vec2(n(p*1.3-t*1.1)*.22-.11, n(p*1.3+t*1.1)*.22-.11);
  float b1=exp(-pow(length(p-c1),2.0)*5.0);
  float b2=exp(-pow(length(p-c2),2.0)*9.0)*.7;
  vec3 col=uBg;
  col+=uAccent*b1*uDim;
  col+=uAccent2*b2*uDim;
  float v=1.0-length(uv)*.92;
  col*=clamp(v,0.55,1.0);
  gl_FragColor=vec4(col,1.0);
}`

function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace('#', '').trim()
  const full = s.length === 3 ? s.split('').map(c => c + c).join('') : s
  const n = parseInt(full, 16)
  if (Number.isNaN(n)) return [0, 0, 0]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255) as [number, number, number]
}
function readCssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fallback
}
// rgba(...) → rgb 三分量
function rgbaToRgb(color: string): [number, number, number] {
  const m = color.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/)
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]
  return hexToRgb(color)
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn('shader', gl.getShaderInfoLog(sh)); return null }
  return sh
}

export default function WebglBackdrop({ dim = 0.16, className = '', staticMode = false }: { dim?: number; className?: string; staticMode?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!gl) return

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) return
    const prog = gl.createProgram()!
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn('link', gl.getProgramInfoLog(prog)); return }
    gl.useProgram(prog)

    // 全屏三角（覆盖整个裁剪空间）
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(prog, 'uRes')
    const uTime = gl.getUniformLocation(prog, 'uTime')
    const uBg = gl.getUniformLocation(prog, 'uBg')
    const uAccent = gl.getUniformLocation(prog, 'uAccent')
    const uAccent2 = gl.getUniformLocation(prog, 'uAccent2')
    const uDim = gl.getUniformLocation(prog, 'uDim')

    const el = document.documentElement
    let raf = 0
    let t = 0
    const reduced = lessMotion()

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.floor(canvas.clientWidth * dpr) || 1
      const h = Math.floor(canvas.clientHeight * dpr) || 1
      canvas.width = w; canvas.height = h
      gl.viewport(0, 0, w, h)
      gl.uniform2f(uRes, w, h)
    }

    const readColors = () => setColors()
    const setColors = () => {
      gl.uniform3fv(uBg, hexToRgb(readCssVar(el, '--pi-bg', '#0e1116')))
      gl.uniform3fv(uAccent, rgbaToRgb(readCssVar(el, '--pi-accent', '#5468ff')))
      gl.uniform3fv(uAccent2, rgbaToRgb(readCssVar(el, '--pi-accent2', '#7b96ff')))
      gl.uniform1f(uDim, Math.max(0.05, Math.min(0.9, dim)))
    }

    const draw = (now?: number) => {
      if (now !== undefined && !reduced) t = now / 1000
      gl.uniform1f(uTime, t)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    // 页签隐藏/最小化时停帧（以前一直画，软件渲染机器上白吃 CPU）
    const loop = (now: number) => { if (document.hidden) { raf = 0; return } draw(now); raf = requestAnimationFrame(loop) }
    const onVis = () => { if (!document.hidden && !raf && !reduced && !staticMode) raf = requestAnimationFrame(loop) }
    document.addEventListener('visibilitychange', onVis)

    resize(); setColors(); draw(0)
    if (!reduced && !staticMode) raf = requestAnimationFrame(loop)

    const ro = new ResizeObserver(() => resize())
    ro.observe(canvas)
    // 主题变化（内联派生的 style 属性 / data-theme）→ 刷新颜色
    const mo = new MutationObserver(() => { setColors(); if (reduced || staticMode) draw(0) })
    mo.observe(el, { attributes: true, attributeFilter: ['style', 'data-theme'] })

    return () => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); ro.disconnect(); mo.disconnect(); gl.deleteBuffer(buf); gl.deleteProgram(prog) }
  }, [dim, staticMode])

  return <canvas ref={canvasRef} aria-hidden className={`w-full h-full ${className}`} style={{ display: 'block' }} />
}
