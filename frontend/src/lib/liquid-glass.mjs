// 液态玻璃（2026-11-17）：不引 WebGPU 库，用 SVG 滤镜做 backdrop 折射。
// 位移图按元素实际像素尺寸生成：中间平（不变形），四周一圈向内取样（凸透镜边缘的挤压感）；
// R/G/B 三个通道用略不同的位移量，边缘出一点棱镜色散。
// 只有 Chromium 支持 backdrop-filter: url(#…)；其他浏览器只用 CSS 里的毛玻璃，不调本模块。

export function refractionSupported(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  return /(?:Chrome|Chromium|Edg)\//.test(ua) && !/\bFirefox\//.test(ua) // 含 HeadlessChrome
}

// 一个通道的渐变：两端 = 向内取样，中间 128 = 不动
function edgeStops(color, edge) {
  const e = Math.min(0.5, Math.max(0.02, edge))
  const c = (v) => color.replace('V', v)
  return `<stop offset="0" stop-color="${c(255)}"/><stop offset="${e}" stop-color="${c(128)}"/>` +
    `<stop offset="${1 - e}" stop-color="${c(128)}"/><stop offset="1" stop-color="${c(0)}"/>`
}

export function displacementMap(w, h, radius) {
  const band = Math.max(8, Math.min(radius * 1.1, 28)) // 折射带宽度（px）
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<defs><linearGradient id="x" x1="0" x2="1" y1="0" y2="0">${edgeStops('rgb(V,0,0)', band / w)}</linearGradient>` +
    `<linearGradient id="y" x1="0" x2="0" y1="0" y2="1">${edgeStops('rgb(0,V,0)', band / h)}</linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#x)"/>` +
    `<rect width="${w}" height="${h}" fill="url(#y)" style="mix-blend-mode:screen"/></svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

export function buildLiquidFilter(id, width, height, radius = 16, strength = 1) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height))
  const s = Math.round(Math.min(w, h, 48) * 0.5 * strength) // 位移量随大小走，小胶囊不至于扭成一团
  const channel = (scale, matrix, out) =>
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="d${out}"/>` +
    `<feColorMatrix in="d${out}" type="matrix" values="${matrix}" result="${out}"/>`
  return `<filter id="${id}" x="0" y="0" width="${w}" height="${h}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
    `<feImage href="${displacementMap(w, h, radius)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>` +
    channel(s, '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0', 'r') +
    channel(Math.round(s * 1.06), '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0', 'g') +
    channel(Math.round(s * 1.12), '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0', 'b') +
    `<feBlend in="r" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b" mode="screen"/></filter>`
}
