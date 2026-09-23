import { sceneBackdrop, sceneFor } from './studio-state.mjs'
import type { Idea } from './studio-state.mjs'

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image()
  const timer = setTimeout(() => { image.src = ''; reject(new Error('图片加载超时')) }, 12000)
  image.onload = () => { clearTimeout(timer); resolve(image) }
  image.onerror = () => { clearTimeout(timer); reject(new Error('图片暂不可用')) }
  image.src = src
})
export async function saveStudioPhoto(sceneId: string, source: string, name: string, idea: Idea) {
  const scene = sceneFor(sceneId)
  const [backdrop, portrait] = await Promise.all([
    loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sceneBackdrop(sceneId))), loadImage(source),
  ])
  const canvas = document.createElement('canvas'); canvas.width = 840; canvas.height = 1000
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前设备不支持保存图片')
  ctx.fillStyle = '#faf5ea'; ctx.fillRect(0, 0, 840, 1000)
  ctx.drawImage(backdrop, 30, 30, 780, 613)
  const scale = Math.min(400 / portrait.naturalWidth, 485 / portrait.naturalHeight)
  const w = portrait.naturalWidth * scale, h = portrait.naturalHeight * scale
  ctx.drawImage(portrait, 420 - w / 2, 530 - h, w, h)
  ctx.fillStyle = '#3c372e'; ctx.textAlign = 'center'
  ctx.font = '500 24px sans-serif'; ctx.fillText(`${name.slice(0, 16)} · ${scene.label} / ${idea.date}`, 420, 700, 740)
  ctx.font = '600 42px sans-serif'; ctx.fillText(idea.title, 420, 777, 740)
  ctx.font = '28px sans-serif'
  const chars = Array.from(idea.text)
  for (let i = 0; i < chars.length; i += 23) ctx.fillText(chars.slice(i, i + 23).join(''), 420, 843 + i / 23 * 42, 740)
  ctx.font = '20px sans-serif'; ctx.fillText('元枢 · 小语的桌面展台', 420, 958)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片导出失败')), 'image/png'))
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = `小语-${scene.label}-${idea.date}.png`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
