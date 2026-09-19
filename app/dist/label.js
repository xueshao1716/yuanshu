// 小语木偶 · 部件标注页的逻辑（外链脚本：站点 CSP 是 script-src 'self'，内联脚本会被拦）
const BASE = '/static/branding/'
const PARTS = [
  { id: 'head', label: '头（含耳机）', color: '#7dd3fc', box: [0.28, 0.02, 0.78, 0.19], pivot: 'bottom-center' },
  { id: 'armL', label: '左臂（画面左）', color: '#fca5a5', box: [0.20, 0.20, 0.40, 0.52], pivot: 'top-center' },
  { id: 'armR', label: '右臂（画面右）', color: '#fdba74', box: [0.62, 0.20, 0.82, 0.52], pivot: 'top-center' },
  { id: 'torso', label: '躯干（连帽卫衣）', color: '#86efac', box: [0.32, 0.18, 0.70, 0.62], pivot: 'bottom-center' },
  { id: 'legL', label: '左腿（画面左）', color: '#c4b5fd', box: [0.32, 0.60, 0.50, 0.98], pivot: 'top-center' },
  { id: 'legR', label: '右腿（画面右）', color: '#f9a8d4', box: [0.52, 0.60, 0.70, 0.98], pivot: 'top-center' },
]
const pic = document.getElementById('pic')
const wrap = document.getElementById('wrap')
const out = document.getElementById('out')
const msg = document.getElementById('msg')
let imgName = 'xiaoyu-stand'
const boxes = {}

function payload() {
  return { image: imgName, size: [pic.naturalWidth, pic.naturalHeight], parts: PARTS.map((p) => ({ id: p.id, box: boxes[p.id], pivot: p.pivot })) }
}

function draw() {
  wrap.querySelectorAll('.box').forEach((el) => el.remove())
  const W = pic.clientWidth, H = pic.clientHeight
  for (const p of PARTS) {
    const b = boxes[p.id]
    if (!b) continue
    const el = document.createElement('div')
    el.className = 'box'
    el.style.borderColor = p.color
    el.style.left = (b[0] * W) + 'px'
    el.style.top = (b[1] * H) + 'px'
    el.style.width = ((b[2] - b[0]) * W) + 'px'
    el.style.height = ((b[3] - b[1]) * H) + 'px'
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.style.background = p.color
    tag.textContent = p.label
    const handle = document.createElement('span')
    handle.className = 'h'
    el.appendChild(tag); el.appendChild(handle)
    el.addEventListener('pointerdown', (e) => start(e, p.id, e.target === handle))
    wrap.appendChild(el)
  }
  out.value = JSON.stringify(payload(), null, 1)
}

function start(e, pid, resize) {
  e.preventDefault()
  const W = pic.clientWidth, H = pic.clientHeight
  const sx = e.clientX, sy = e.clientY
  const b0 = boxes[pid].slice()
  const move = (ev) => {
    const dx = (ev.clientX - sx) / W, dy = (ev.clientY - sy) / H
    const b = b0.slice()
    if (resize) {
      b[2] = Math.min(1, Math.max(b[0] + 0.03, b0[2] + dx))
      b[3] = Math.min(1, Math.max(b[1] + 0.03, b0[3] + dy))
    } else {
      const w = b0[2] - b0[0], h = b0[3] - b0[1]
      b[0] = Math.min(1 - w, Math.max(0, b0[0] + dx))
      b[1] = Math.min(1 - h, Math.max(0, b0[1] + dy))
      b[2] = b[0] + w; b[3] = b[1] + h
    }
    boxes[pid] = b.map((v) => Math.round(v * 1000) / 1000)
    draw()
  }
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function guess() {
  boxes.head = [0.26, 0.02, 0.80, 0.19]
  boxes.torso = [0.30, 0.17, 0.72, 0.62]
  boxes.armL = [0.18, 0.19, 0.38, 0.53]
  boxes.armR = [0.64, 0.19, 0.84, 0.53]
  boxes.legL = [0.31, 0.59, 0.50, 0.99]
  boxes.legR = [0.51, 0.59, 0.70, 0.99]
  draw()
}

document.getElementById('reset').addEventListener('click', () => { for (const p of PARTS) boxes[p.id] = p.box.slice(); draw() })
document.getElementById('auto').addEventListener('click', guess)
document.getElementById('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(payload())); msg.textContent = 'JSON 已复制' } catch { msg.textContent = '复制失败，直接从下面文本框里拿' }
})
document.getElementById('save').addEventListener('click', async () => {
  msg.textContent = '保存中…'
  try {
    const r = await fetch('/api/puppet/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('yuanshu_access_token') || 'love#1126469194') },
      body: JSON.stringify(payload()),
    })
    const j = await r.json().catch(() => ({}))
    msg.textContent = r.ok ? ('已保存：' + (j.file || '工作区')) : ('保存失败：' + (j.error || r.status))
  } catch (e) { msg.textContent = '保存失败：' + e.message }
})
document.getElementById('imgSel').addEventListener('change', (e) => { imgName = e.target.value; pic.src = BASE + imgName + '.png' })
pic.addEventListener('load', () => {
  for (const p of PARTS) if (!boxes[p.id]) boxes[p.id] = p.box.slice()
  guess()
})
window.addEventListener('resize', draw)
pic.src = BASE + imgName + '.png'
